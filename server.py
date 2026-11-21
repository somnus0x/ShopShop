"""Run the design prototype over Streamable HTTP or stdio."""
import base64
import json
import os
import sys
from typing import Annotated, Any, Literal

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent, ToolAnnotations
from pydantic import BaseModel, ConfigDict, Field
from story_data import ROOT, build_story

URI = "ui://shopshop/profile-gifts-v4.html"
MIME = "text/html;profile=mcp-app"
app = FastMCP("shopshop", host=os.getenv("HOST","127.0.0.1"), port=int(os.getenv("PORT", "8000")),
              stateless_http=True, json_response=True)

class Place(BaseModel):
    name: Annotated[str, Field(min_length=1, max_length=100)]
    relation: Literal["favorite", "visited", "planned"]
    excerpt: Annotated[str, Field(min_length=1, max_length=240)]

class Post(BaseModel):
    cue: Literal["race", "travel", "gym", "dogs", "plaid", "flowers", "place"]
    caption: Annotated[str, Field(min_length=1,max_length=480)]
    place: Place | None = None
    source_url: Annotated[str, Field(max_length=2048)] = ""
    image_index: Annotated[int | None, Field(ge=0, le=5)] = None

class ChatFile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    download_url: str
    file_id: Annotated[str, Field(min_length=1, max_length=256)]
    mime_type: str = ""
    file_name: str = ""

@app.tool(meta={"ui":{"resourceUri":URI},"openai/outputTemplate":URI,"openai/fileParams":["post_images"]},
          annotations=ToolAnnotations(readOnlyHint=True, destructiveHint=False, openWorldHint=False))
def source_gifts(profile_url: str = "", posts: Annotated[list[Post], Field(max_length=6)] = [],
                 demo: bool = False, budget_thb: Annotated[int | None, Field(ge=0)] = None,
                 post_images: Annotated[list[ChatFile], Field(max_length=6)] = []) -> Annotated[CallToolResult, dict[str, Any]]:
    """Find Thai gifts tied to actual IG/FB post evidence. Pass the recipient's profile URL.
    Supply only verbatim captions or screenshot text available in this conversation or
    actually read from that profile. Never invent posts or infer from a handle.
    race requires a race entry, travel requires a backpack trip, gym requires bringing gym clothes.
    dogs, plaid and flowers require a positive expressed interest in dogs, wearing plaid, or flowers.
    For an explicitly named destination, supply its exact name and a verbatim excerpt from the caption.
    Use favorite only for expressed liking or returning by preference; distinguish visits and plans.
    Use cue=place for a location-only caption. Use only public destinations, never home, workplace or inferred location.
    Use the overview to explain interests and give an in-budget gift with its supporting captions.
    For an inaccessible profile or unsupported evidence, omit posts and ask in chat for an applicable post.
    Put actual user-attached post screenshots in post_images. For a matching post, set image_index
    to its zero-based position in post_images. Include source_url only when its exact post permalink
    was supplied or observed. Leave unmatched captions without an image_index. Never invent file IDs or URLs.
    Use demo=true only for an explicitly requested fictional June demo. Prices are catalog snapshots."""
    result = build_story(profile_url, [p.model_dump() for p in posts], demo, budget_thb)
    images = {}
    if not demo and result["status"] == "ready":
        story_ids = {story["caption"].strip(): str(i) for i, story in enumerate(result["stories"])}
        for post in posts:
            i = post.image_index
            if i is None or i >= len(post_images):
                continue
            file = post_images[i]
            if file.mime_type and file.mime_type.lower() not in {"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}:
                continue
            images.setdefault(story_ids[post.caption.strip()], {"file_id": file.file_id})
    return CallToolResult(structuredContent=result, content=[TextContent(type="text", text=json.dumps(result, ensure_ascii=False))],
                          _meta={"post_images": images})

def component():
    html = (ROOT/"story.html").read_text()
    image = base64.b64encode((ROOT/"assets/turntable.webp").read_bytes()).decode()
    script = (ROOT/"turntable.js").read_text().replace("assets/turntable.webp","data:image/webp;base64,"+image)
    def artwork(filename):
        encoded = base64.b64encode((ROOT/"assets"/filename).read_bytes()).decode()
        return "data:image/webp;base64," + encoded
    return (html.replace("/* STORY_STYLE */",(ROOT/"story.css").read_text())
            .replace("CI_JUNE", artwork("june-recap.webp"))
            .replace("CI_MARK", artwork("loop-mark.webp"))
            .replace("/* RECAP */",(ROOT/"recap.js").read_text())
            .replace("/* STORY_APP */",(ROOT/"story.js").read_text())
            .replace("/* TURNTABLE */",script)
            .replace('"DEMO_FIXTURE"',json.dumps(build_story(demo=True),ensure_ascii=False)))

@app.resource(URI, mime_type=MIME, meta={"ui":{"prefersBorder":True,"csp":{"connectDomains":[],
              "resourceDomains":["https://*.oaiusercontent.com","https://chatgpt.com"]}}})
def story_component() -> str:
    return component()

if __name__ == "__main__":
    if "--preview" in sys.argv:
        (ROOT/"index.html").write_text(component())
    else:
        app.run(transport="stdio" if "--stdio" in sys.argv else "streamable-http")
