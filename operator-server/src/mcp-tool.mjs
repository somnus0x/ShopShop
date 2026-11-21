import { z } from 'zod';

export function toolResult(data, extraContent = []) {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }, ...extraContent] };
}

export function defineTool(name, description, schema, call, readOnlyHint = false) {
  const { $schema, ...inputSchema } = z.toJSONSchema(schema, { io: 'input' });
  return {
    definition: { name, description, inputSchema, annotations: { readOnlyHint, destructiveHint: false } },
    invoke: input => call(schema.parse(input)),
  };
}
