import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { eventDefinition } from './events.mjs';
import { CallbackVerificationError } from './webhooks.mjs';
import { productTools } from './product-inquiries.mjs';
import { productCatalogTools } from './product-catalog.mjs';
import { toolResult } from './mcp-tool.mjs';

const diagnosticFields = new Set(['name', 'arguments', 'recipient', 'delivery', 'mode', 'url', 'secret', 'cursor', 'ttlMs', '_meta', 'progressToken', 'io.modelcontextprotocol/related-task', 'taskId']);
const callbackReasons = new Set(['timeout', 'transport_error', 'http_4xx', 'http_5xx', 'http_error', 'challenge_failed']);
function safeIssues(error) {
  return error.issues.slice(0, 10).map(issue => ({
    code: issue.code,
    path: issue.path.slice(0, 6).map(part => typeof part === 'number' ? part : diagnosticFields.has(part) ? part : '<field>'),
  }));
}

const idSchema = z.object({ inquiry_id: z.string().min(1).max(80) }).strict();
const resultSchema = z.object({
  inquiry_id: z.string().min(1).max(80), claim_token: z.string().uuid(),
  outcome: z.enum(['sent', 'failed', 'needs_attention']),
  evidence: z.string().trim().min(1).max(2000),
}).strict();
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const inquiryInput = object({ inquiry_id: { type: 'string' } }, ['inquiry_id']);
export const toolDefinitions = [
  {
    name: 'get_poc_status', title: 'Get shopping POC status',
    description: 'Get subscription, inquiry, and webhook delivery counts. A delivered webhook does not mean an Instagram DM was sent.',
    inputSchema: object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'get_inquiry', title: 'Get test inquiry',
    description: 'Read one authorized test inquiry and its recipient, exact message, and current status.',
    inputSchema: inquiryInput,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'claim_inquiry', title: 'Claim test inquiry',
    description: 'Atomically reserve a pending inquiry before executing it. A can_send=false result means another execution has already claimed or completed it. This tool itself does not send a message.',
    inputSchema: inquiryInput,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'record_inquiry_result', title: 'Record inquiry result',
    description: 'Record an agent-observed result for a claimed inquiry. Use sent only when Instagram visibly shows the outgoing message; otherwise record failed or needs_attention. Does not send a message.',
    inputSchema: object({
      inquiry_id: { type: 'string' }, claim_token: { type: 'string' },
      outcome: { type: 'string', enum: ['sent', 'failed', 'needs_attention'] },
      evidence: { type: 'string', minLength: 1, maxLength: 2000 },
    }, ['inquiry_id', 'claim_token', 'outcome', 'evidence']),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
].map(tool => ({ ...tool, outputSchema: { type: 'object', additionalProperties: true } }));

export function createMcpServer(store, events, { productInquiries, productDetails, onEventDiagnostic = entry => console.error(JSON.stringify(entry)) } = {}) {
  const operatorTools = [
    ...(productInquiries ? productTools(productInquiries, 'operator') : []),
    ...productCatalogTools(productDetails),
  ];
  const server = new Server(
    { name: 'sea-hackathon-shopping-events', version: '0.1.0' },
    { capabilities: { tools: {}, events: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...toolDefinitions, ...operatorTools.map(tool => tool.definition)] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const input = request.params.arguments ?? {};
    try {
      let result;
      switch (request.params.name) {
        case 'get_poc_status': z.object({}).strict().parse(input); result = store.status(); break;
        case 'get_inquiry': {
          const args = idSchema.parse(input);
          result = store.getInquiry(args.inquiry_id);
          if (!result) throw new Error('Inquiry not found');
          break;
        }
        case 'claim_inquiry': result = store.claimInquiry(idSchema.parse(input).inquiry_id); break;
        case 'record_inquiry_result': {
          const args = resultSchema.parse(input);
          result = store.completeInquiry(args.inquiry_id, args.claim_token, args.outcome, args.evidence);
          break;
        }
        default: {
          const tool = operatorTools.find(candidate => candidate.definition.name === request.params.name);
          if (!tool) throw new Error('Unknown tool');
          return tool.invoke(input);
        }
      }
      return toolResult(result);
    } catch (error) {
      const text = error instanceof z.ZodError ? 'Invalid tool arguments' : error.message;
      return { isError: true, content: [{ type: 'text', text }] };
    }
  });
  server.setRequestHandler(z.object({ method: z.literal('events/list'), params: z.object({ cursor: z.null().optional() }).optional() }),
    async () => ({ events: [eventDefinition] }));
  for (const method of ['events/subscribe', 'events/unsubscribe']) {
    server.setRequestHandler(z.object({ method: z.literal(method), params: z.unknown() }), async request => {
      let stage = 'request';
      const report = (status, extra = {}) => {
        // Only fixed method/stage/status fields and sanitized error categories cross
        // this boundary. Never log request values, callback data, or raw errors.
        try { onEventDiagnostic({ component: 'mcp-events', method, stage, status, ...extra }); } catch { /* diagnostics cannot alter execution */ }
      };
      const nextStage = next => { report('success'); stage = next; report('start'); };
      report('start');
      try {
        const result = method === 'events/subscribe'
          ? await events.subscribe(request.params, nextStage)
          : events.unsubscribe(request.params, nextStage);
        report('success');
        stage = 'complete';
        report('success');
        return result;
      } catch (error) {
        const invalid = error instanceof z.ZodError;
        const reason = error instanceof CallbackVerificationError && callbackReasons.has(error.reason) ? error.reason : 'challenge_failed';
        report('failure', invalid ? { issues: safeIssues(error) } : { reason });
        if (method === 'events/unsubscribe') throw new McpError(ErrorCode.InvalidParams, 'Invalid unsubscribe arguments');
        if (invalid) throw new McpError(ErrorCode.InvalidParams, 'Invalid subscription arguments');
        throw new McpError(-32015, 'Callback verification failed', { reason });
      }
    });
  }
  return server;
}
