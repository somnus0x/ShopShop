"""Profile evidence and curated gift pairings for the design demo."""
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent
CATALOG = json.loads((ROOT / "brand-corpus.json").read_text())
PRODUCTS = {p["id"]: dict(p, brand=b["name"]) for b in CATALOG["brands"] for p in b["products"]}
PAIRINGS = {
    "race": ("clover", "เชียร์วันแข่ง", "🍀", "ให้โคลเวอร์ไว้ห้อยกระเป๋าวันแข่ง เป็นคำว่า “สู้ ๆ” ที่เธอพกไปได้ โดยไม่ต้องเดาว่าเธอใช้อุปกรณ์ซ้อมแบบไหน", "วันแข่งสู้ ๆ นะ ไว้มาเล่าให้ฟังด้วย ☘"),
    "travel": ("flower", "เป้ใบที่ไปด้วยทุกทริป", "🎒", "ถ้าเธอเดินทางด้วยเป้ใบเดียว แท็กสีสดช่วยให้จำเป้ของตัวเองได้ไว แล้วเธอก็ใช้ของใบโปรดต่อได้", "เอาไว้ห้อยเป้ใบนั้นนะ ทริปหน้าขอดูรูปด้วย :)"),
    "gym": ("golf-bag", "แวะยิมหลังเลิกงาน", "🏃", "รุ่นนี้เป็นกระเป๋าใส่เสื้อผ้ากอล์ฟ แต่ใช้พกชุดเปลี่ยนไปยิมได้ด้วย เลือกชิ้นนี้ถ้าเธอกำลังมองหากระเป๋าอีกใบจริง ๆ", "เห็นว่าต้องหอบชุดไปเปลี่ยนบ่อย เลยนึกถึงใบนี้"),
}
# Each cue is assigned by the host only when the supplied caption supports it.
# Secondary uses are editorial suggestions, not additional facts about the recipient.
PAIRINGS.update({
    "trip": ("flower", "เรื่องเล่าจากทริป", "🧳", "แท็กห้อยกระเป๋าสีสดช่วยให้สังเกตกระเป๋าได้ง่ายขึ้นระหว่างเดินทาง เป็นของเล็ก ๆ ที่โยงถึงทริปในโพสต์", "เห็นโพสต์ทริปนี้แล้วนึกถึงชิ้นนี้ เอาไว้พาไปทริปหน้านะ"),
    "dogs": ("doggo", "ชอบสุนัข", "🐶", "แท็กลายน้องหมาเป็นของเล็ก ๆ ที่โยงถึงเรื่องที่เธอชอบคุยได้", "เห็นน้องหมาตัวนี้แล้วนึกถึงเธอ"),
    "plaid": ("faye", "ชอบใส่ลายตาราง", "🎀", "เสื้อ Faye ใช้ลายตารางสีน้ำตาล ถ้ารู้ว่าเธอชอบลายนี้ ลองชวนเธอเลือกไซซ์ด้วยกัน", "เห็นลายตารางแล้วนึกถึงเสื้อตัวโปรดของเธอ"),
    "flowers": ("flower", "ชอบดอกไม้", "🌸", "แท็กรูปดอกไม้ชิ้นนี้ห้อยกับกระเป๋าใบเดิมได้ เธอจึงพกดอกไม้ติดตัวไปได้ทุกวัน", "ดอกนี้เอาไว้พาไปเที่ยวด้วยนะ"),
    "music": ("clover", "เพลงและการแสดง", "🎵", "แท็กโคลเวอร์ห้อยกระเป๋าที่พกไปซ้อมหรือไปแสดง เป็นคำอวยพรเล็ก ๆ ก่อนเริ่มงาน", "ขอให้โชว์ออกมาดี :)"),
})
LIKES = {
    "race":"ลงแข่งกีฬา", "gym":"ออกกำลังกายหลังเลิกงาน", "travel":"เที่ยวด้วยเป้ใบเดียว",
    "trip":"ท่องเที่ยว", "dogs":"สุนัข", "plaid":"เสื้อผ้าลายตาราง", "flowers":"ดอกไม้",
    "music":"เพลงและการแสดง",
}
VIBE_TOPICS = {
    "race": "การลงแข่งกีฬา", "gym": "การออกกำลังกายหลังเลิกงาน",
    "travel": "ทริปที่พกเป้ใบเดียว", "trip": "การเดินทาง",
    "dogs": "สุนัข", "plaid": "เสื้อผ้าลายตาราง", "flowers": "ดอกไม้",
    "music": "เพลงและการแสดง",
}
SHORT_REASONS = {
    "race": "โคลเวอร์ห้อยกระเป๋า เป็นคำว่า “สู้ ๆ” ที่พกไปวันแข่งได้",
    "trip": "แท็กสีสดไว้ห้อยกระเป๋าตอนออกทริป หยิบกระเป๋าของตัวเองได้ง่ายขึ้น",
    "travel": "แท็กสีสดช่วยให้เธอจำเป้ใบโปรดได้ไวตอนเดินทาง",
    "gym": "ใบนี้ใส่ชุดเปลี่ยนไปยิมหลังเลิกงานได้",
    "dogs": "แท็กลายน้องหมาห้อยกระเป๋าได้ ให้เธอพกสิ่งที่ชอบไปทุกวัน",
    "plaid": "เสื้อผูกโบลายตารางเข้ากับลายที่เธอชอบใส่ ชวนกันเลือกไซซ์ได้",
    "flowers": "ดอกไม้ที่ห้อยกระเป๋าใบโปรดไปด้วยได้ทุกวัน",
    "music": "แท็กโคลเวอร์สำหรับกระเป๋าที่พกไปซ้อมหรือไปแสดง",
}
CROSSOVER = {
    "clover": {"travel":"ห้อยไว้กับเป้ใบเดิมเวลาไปเที่ยวได้", "gym":"ใช้เป็นเครื่องรางเล็ก ๆ บนกระเป๋าไปยิมได้"},
    "doggo": {"travel":"ลายน้องหมาติดไปกับเป้ใบเดียวที่พาไปเที่ยวได้"},
    "flower": {"gym":"ห้อยกับกระเป๋าไปยิมให้จำใบของตัวเองง่ายขึ้น"},
}

def profile_read(stories, budget_thb=None):
    groups = {}
    for index, story in enumerate(stories):
        groups.setdefault(story["cue"], []).append(index)
    likes = [{"label":LIKES[cue], "posts":indices} for cue, indices in groups.items() if cue in LIKES]
    labels = [like["label"] for like in likes]
    if not labels:
        headline = "พิกัดที่เธอพูดถึงในโพสต์"
    elif len(stories) == 1:
        headline = "โพสต์นี้เล่าเรื่อง" + labels[0]
    elif {"race","travel"} <= groups.keys():
        headline = "วันแข่งก็ลุย วันเที่ยวก็เป้ใบเดียว"
    elif {"race","gym"} <= groups.keys():
        headline = "จากวันซ้อม ถึงวันแข่ง"
    elif len(labels) == 1:
        headline = "เรื่องที่เห็นจากโพสต์คือ" + labels[0]
    else:
        headline = labels[0] + " × " + labels[1]

    options = []
    for primary, story in enumerate(stories):
        if "item" not in story:
            continue
        item = story["item"]
        supporting = [primary]
        reasons = [story["reason"]]
        for cue, indices in groups.items():
            if cue not in PAIRINGS or cue == story["cue"]:
                continue
            if PAIRINGS[cue][0] == item:
                supporting.append(indices[0])
                reasons.append(stories[indices[0]]["reason"])
            elif cue in CROSSOVER.get(item, {}):
                supporting.append(indices[0])
                reasons.append(CROSSOVER[item][cue])
        options.append((story["eligible"], len(supporting), -story["price"], -primary, supporting, reasons))
    pick = None
    if options:
        # Within budget, favor evidence strength. Otherwise minimize the overage.
        _, _, _, negative_primary, supporting, reasons = max(
            options, key=lambda option: (option[0], *option[1:4]) if option[0]
            else (False, option[2], option[1], option[3])
        )
        pick = dict(stories[-negative_primary], reason=" ".join(reasons), evidence=supporting)
        if not pick["eligible"] and budget_thb is not None:
            pick["over_budget_thb"] = pick["price"] - budget_thb
    places = {}
    for i, story in enumerate(stories):
        place = story.get("place")
        if place:
            places.setdefault((place["name"],place["relation"]),[]).append(i)
    destinations = [{"name":name, "relation":relation, "posts":indices}
                    for (name, relation), indices in places.items()]
    if pick:
        pick["short_reason"] = SHORT_REASONS[pick["cue"]]
        if pick["item"] == "clover" and any(stories[i]["cue"] == "travel" for i in pick["evidence"]):
            pick["short_reason"] = "ห้อยโคลเวอร์กับเป้ใบโปรด ให้เธอพกคำว่า “สู้ ๆ” ไปทั้งวันแข่งและวันเที่ยว"
        if pick["item"] in {"clover","doggo","flower"}:
            pick["reason"] += " ชิ้นเล็กพกไปให้ตอนนัดกาแฟได้ และไม่ต้องเดาไซซ์"
        for place in destinations:
            if place["relation"] == "favorite" and any(i in pick["evidence"] and stories[i]["cue"] == "travel" for i in place["posts"]):
                pick["note"] = "ทริปหน้าไป" + place["name"] + " พาชิ้นนี้ไปด้วยนะ :)"
                break
    ranked = sorted(groups, key=lambda cue: -len(groups[cue]))
    subjects = [VIBE_TOPICS[cue] for cue in ranked if cue in VIBE_TOPICS
                and (cue != "trip" or "travel" not in groups)]
    if subjects:
        vibe_summary = "โพสต์ที่เลือกเล่าเรื่อง" + "และ".join(subjects[:2])
    else:
        vibe_summary = "โพสต์ที่เลือกพูดถึงสถานที่เป็นหลัก"
    place_names = list(dict.fromkeys(place["name"] for place in destinations))
    if place_names:
        vibe_summary += " โดยพูดถึง " + " และ ".join(place_names[:2])
    return {"headline":headline, "vibe_summary":vibe_summary, "likes":likes,
            "places":destinations, "pick":pick}

DEMO_POSTS = [
    {"cue":"race","caption":"สมัคร HYROX สนามแรกแล้ววว วันเสาร์นี้ขอแค่เข้าเส้นชัยก็พอ 🥹"},
    {"cue":"travel","caption":"เชียงใหม่ 3 วัน เอาเป้ไปใบเดียวเหมือนเดิม ชอบกลับมาเชียงใหม่ทุกหน้าหนาว 🎒",
     "place":{"name":"เชียงใหม่","relation":"favorite","excerpt":"ชอบกลับมาเชียงใหม่ทุกหน้าหนาว"}},
    {"cue":"gym","caption":"เลิกงานแล้วไปยิมต่อ วันนี้ลืมหยิบชุดมาเปลี่ยนอีกแล้ว 🫠"},
]

def platform(url):
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme != "https" or parsed.username is not None or port not in (None, 443) or not parsed.path.strip("/"):
        return None
    host = parsed.hostname or ""
    for domain, name in (("instagram.com","Instagram"),("facebook.com","Facebook")):
        if host in {domain, "www."+domain, "m."+domain}:
            return name
    return None

def instagram_handle(url):
    if platform(url) != "Instagram":
        return None
    handle = urlsplit(url).path.strip("/").lower()
    if re.fullmatch(r"[a-z0-9._]{1,30}", handle) and handle not in {"p", "reel", "reels", "stories", "explore", "accounts", "direct"}:
        return handle
    return None


def post_permalink(url, network):
    """Keep only a same-platform post path and its identifying parameters."""
    if not url or platform(url) != network:
        return None
    parts = urlsplit(url)
    path = parts.path.rstrip("/")
    if network == "Instagram" and re.fullmatch(r"/(?:p|reel)/[A-Za-z0-9_-]+", path):
        return f"https://www.instagram.com{path}/"
    if network != "Facebook":
        return None
    if re.fullmatch(r"/[A-Za-z0-9._-]+/posts/[A-Za-z0-9_-]+", path):
        return f"https://www.facebook.com{path}"
    params = parse_qs(parts.query)
    keys = {"photo": ("fbid",), "photo.php": ("fbid",),
            "permalink.php": ("story_fbid", "id")}.get(path.lstrip("/"), ())
    if keys and all(len(params.get(k, [])) == 1 and re.fullmatch(r"[A-Za-z0-9_-]+", params[k][0]) for k in keys):
        return f"https://www.facebook.com{path}?{urlencode([(k, params[k][0]) for k in keys])}"
    return None

# Alternatives use a concrete product feature and the same evidence as the direct pick.
TRAVEL_ALTERNATIVES = {
    "clover": "ใช้ห้อยกระเป๋าเดินทางให้จำใบของตัวเองได้ง่ายขึ้น",
    "doggo": "แท็กทรงน้องหมาเป็นอีกแบบสำหรับแยกกระเป๋าของตัวเองตอนเดินทาง",
}
FITNESS_ALTERNATIVES = {
    "clover": "แท็กโคลเวอร์ไว้ห้อยกระเป๋าไปซ้อมหรือวันแข่ง",
    "flower": "แท็กสีสดสำหรับแยกกระเป๋าออกกำลังกาย",
}


def gift_alternatives(stories, primary, budget_thb, indices):
    options = {}
    if primary:
        options[primary["item"]] = primary
    for i in indices:
        story = stories[i]
        cue = story["cue"]
        if story.get("item") and story["item"] not in options:
            options[story["item"]] = {**story, "evidence": [i], "short_reason": SHORT_REASONS[cue]}
        alternatives = (TRAVEL_ALTERNATIVES if cue in {"trip", "travel"} else
                        FITNESS_ALTERNATIVES if cue in {"race", "gym"} else {})
        for item, reason in alternatives.items():
            if item not in options:
                options[item] = catalog_pick(item, budget_thb, reason, [i])
    for item in PRODUCTS:
        if item not in options:
            options[item] = catalog_pick(item, budget_thb, "ตัวเลือกทั่วไปจากแคตตาล็อก", [])
    for item in options.values():
        if budget_thb is not None and item["price"] > budget_thb:
            item["over_budget_thb"] = item["price"] - budget_thb
    return sorted(options.values(), key=lambda option: (
        not option["eligible"], not option.get("evidence"), option.get("over_budget_thb", 0),
        (budget_thb-option["price"]) if option.get("catalog_fallback") and option["eligible"] and budget_thb is not None else 0,
    ))[:3]


def catalog_pick(item, budget_thb, reason, evidence):
    product = PRODUCTS[item]
    price = product["price_thb"]
    return {"item": item, "product": product["name"], "brand": product["brand"], "price": price,
            "eligible": budget_thb is None or price <= budget_thb, "reason": reason,
            "short_reason": reason, "note": "เห็นชิ้นนี้แล้วนึกถึงเธอ", "evidence": evidence,
            "catalog_fallback": not evidence}


_BAG_REASONS = {
    "aman-jekel-h-messenger": "กระเป๋าสะพายสำหรับพกของระหว่างเดินทาง",
    "aman-fames-classic-duffle": "กระเป๋าดัฟเฟิลใส่เสื้อผ้าสำหรับออกทริป",
    "overhills-motif-windbreaker-jacket": "เสื้อกันลมสำหรับใส่เป็นชั้นนอกระหว่างเดินทาง",
    "overhills-rover-pants": "กางเกงสำหรับใส่เดินเที่ยว",
    "overhills-resorts-7-shorts": "กางเกงขาสั้นสำหรับใส่ในทริปอากาศร้อน",
}
_TRAINING_REASONS = {
    "overhills-loadlite-5-shorts": "กางเกงขาสั้นสำหรับใส่ซ้อม",
    "overhills-grit-pace-45-shorts": "กางเกงขาสั้นสำหรับใส่วิ่ง",
    "overhills-track-long-sleeve": "เสื้อแขนยาวสำหรับใส่ช่วงวอร์มอัป",
    "overhills-cool-pace-singlet": "เสื้อกล้ามสำหรับใส่ซ้อมหรือวันแข่ง",
    "overhills-airmatte-tee": "เสื้อยืดสำหรับใส่ซ้อมหรือพกไปเปลี่ยนหลังออกกำลังกาย",
    "overhills-bop-taper-tee": "เสื้อยืดอีกตัวสำหรับสลับใส่ไปออกกำลังกาย",
}
_LIVE_REASONS = {"race": _TRAINING_REASONS, "gym": _TRAINING_REASONS,
                 "trip": _BAG_REASONS, "travel": _BAG_REASONS, "place": _BAG_REASONS,
                 "music": {
                     "overhills-bop-taper-tee": "เสื้อยืดสำหรับใส่สบาย ๆ ตอนซ้อมหรืออยู่ในสตูดิโอ",
                     "overhills-airmatte-tee": "เสื้อยืดอีกตัวไว้พกเปลี่ยนระหว่างวันซ้อม",
                     "aman-jekel-h-messenger": "กระเป๋าสะพายสำหรับพกโน้ตเพลงและของชิ้นเล็กไปซ้อม",
                 }}


def apply_live_catalog(result, products, budget_thb):
    priced = [product for product in products if isinstance(product.get("price_thb"), int)
              and not isinstance(product["price_thb"], bool) and product["price_thb"] >= 0
              and product["product_id"] != "demo-supasonk"]
    if not priced:
        return

    def picks(indices):
        choices = []
        for product in priced:
            item = product["product_id"]
            price = product["price_thb"]
            overage = max(0, price - budget_thb) if budget_thb is not None else 0
            matches = [(i, _LIVE_REASONS.get(result["stories"][i]["cue"], {}).get(item)) for i in indices]
            evidence = [i for i, reason in matches if reason]
            reason = next((reason for _, reason in matches if reason), "ตัวเลือกจากร้านในแคตตาล็อกใกล้งบที่ตั้งไว้")
            priority = (bool(overage), overage, not evidence, price)
            choices.append((priority, {
                "item": item, "product": product["name"], "brand": product["brand"] or "",
                "price": price, "eligible": not overage, "over_budget_thb": overage,
                "image_url": product.get("image_url"), "reason": reason, "short_reason": reason,
                "note": "เห็นชิ้นนี้แล้วนึกถึงเธอ", "evidence": evidence, "catalog_fallback": not evidence,
            }))
        return [choice for _, choice in sorted(choices, key=lambda entry: entry[0])[:3]]

    stories = result["stories"]
    result["overview"]["gifts"] = picks(range(len(stories)))
    result["overview"]["pick"] = result["overview"]["gifts"][0]
    for index, story in enumerate(stories):
        story["gifts"] = picks([index])
    result["mock_gifts"] = False
    result["catalog_source"] = "merchant"


def build_story(profile_url="", posts=(), demo=False, budget_thb=None):
    network = "Instagram" if demo else platform(profile_url)
    handle = instagram_handle(profile_url) if network == "Instagram" and not demo else None
    if not network or (network == "Instagram" and not demo and not handle):
        return {"status":"need_profile","message":"ส่งลิงก์โปรไฟล์ Instagram หรือ Facebook ในแชตนี้ได้เลย"}
    stories = []
    seen = set()
    for p in DEMO_POSTS if demo else posts:
        key = p["caption"].strip()
        if key in seen:
            continue
        seen.add(key)
        cue = p["cue"]
        if cue == "place" and re.search(r"\b(?:trip|travel|vacation)\b|ทริป|ไปเที่ยว|เดินทาง", key, re.IGNORECASE):
            cue = "trip"
        if cue == "place":
            stories.append({"caption":p["caption"],"cue":"place","title":"สถานที่ในโพสต์","glyph":"📍","eligible":False})
        else:
            item, title, glyph, reason, note = PAIRINGS[cue]
            product = PRODUCTS[item]
            stories.append({"cue":cue,"item":item,"caption":p["caption"],"title":title,"glyph":glyph,"product":product["name"],
                            "brand":product["brand"],"price":product["price_thb"],"reason":reason,"note":note,
                            "eligible":budget_thb is None or product["price_thb"] <= budget_thb})
        permalink = post_permalink(p.get("source_url"), network)
        if permalink:
            stories[-1]["source_url"] = permalink
        place = p.get("place") or {}
        if (place.get("excerpt") and place.get("name") and place["name"] in place["excerpt"]
                and place["excerpt"] in p["caption"] and place.get("relation") in {"favorite","planned","visited"}):
            stories[-1]["place"] = place
    if not stories:
        return {"status":"need_post","message":"ส่งภาพหน้าจอหรือคัดแคปชันจากโพสต์ของเธอลงในแชตนี้ เพื่อให้เราเลือกของจากสิ่งที่เธอโพสต์จริง ๆ"}
    overview = profile_read(stories, budget_thb)
    overview["gifts"] = gift_alternatives(stories, overview["pick"], budget_thb, range(len(stories)))
    overview["pick"] = overview["gifts"][0]
    post_gifts = [gift_alternatives(stories, None, budget_thb, [i]) for i in range(len(stories))]
    for story, gifts in zip(stories, post_gifts):
        story["gifts"] = gifts
    return {"status":"ready","mock_gifts":True,"demo":demo,"profile":"จูน" if demo else (f"@{handle}" if handle else "เธอ"),"network":network,
            "profile_url":None if demo else profile_url,"budget":budget_thb,"stories":stories,"overview":overview}
