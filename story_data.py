"""Profile evidence and curated gift pairings for the design demo."""
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parent
CATALOG = json.loads((ROOT / "brand-corpus.json").read_text())
PRODUCTS = {p["id"]: dict(p, brand=b["name"]) for b in CATALOG["brands"] for p in b["products"]}
PAIRINGS = {
    "race": ("clover", "Race day", "🍀", "A clover tag for their race bag is a small good-luck gift that fits the gear they already use.", "Good luck on race day. Tell me how it goes ☘"),
    "travel": ("flower", "One bag, every trip", "🎒", "A bright tag makes their favorite backpack easy to spot when they travel with one bag.", "For that backpack of yours. Send me a photo from your next trip :)"),
    "gym": ("golf-bag", "After-work gym", "🏃", "This golf clothing bag can carry a change of clothes for the gym. It fits someone who needs a dedicated gym bag.", "For those days when you squeeze in a workout after work."),
}
# Each cue is assigned by the host only when the supplied caption supports it.
# Secondary uses are editorial suggestions, not additional facts about the recipient.
PAIRINGS.update({
    "trip": ("flower", "Trip highlights", "🧳", "A bright luggage tag makes a travel bag easier to spot and ties back to the trip they shared.", "Your trip made me think of this. Take it on the next one."),
    "dogs": ("doggo", "A soft spot for dogs", "🐶", "A dog-shaped bag tag is a small nod to a subject they love talking about.", "This little dog made me think of you."),
    "plaid": ("faye", "Plaid on repeat", "🎀", "The Faye blouse comes in brown plaid. If they already wear the pattern, you can pick a size together.", "This plaid reminded me of your favorite shirt."),
    "flowers": ("flower", "A thing for flowers", "🌸", "A flower-shaped bag tag lets them carry a little bloom on the bag they already use.", "A little flower to take with you."),
    "music": ("clover", "Music and live shows", "🎵", "A clover tag adds a little good luck to the bag they bring to rehearsal or a show.", "Have a great show :)"),
})
LIKES = {
    "race":"Racing", "gym":"After-work workouts", "travel":"One-bag travel",
    "trip":"Travel", "dogs":"Dogs", "plaid":"Plaid", "flowers":"Flowers",
    "music":"Music and live shows",
}
VIBE_TOPICS = {
    "race": "racing", "gym": "after-work workouts",
    "travel": "one-bag trips", "trip": "travel",
    "dogs": "Dogs", "plaid": "Plaid", "flowers": "Flowers",
    "music": "Music and live shows",
}
SHORT_REASONS = {
    "race": "A little good luck for their race bag.",
    "trip": "A bright tag makes their bag easier to spot on a trip.",
    "travel": "Help their favorite backpack stand out while traveling.",
    "gym": "A bag for their after-work gym kit.",
    "dogs": "A dog-shaped bag tag for everyday use.",
    "plaid": "A plaid bow blouse in a pattern they already wear.",
    "flowers": "A flower to take along on their favorite bag.",
    "music": "A clover tag for rehearsal or show days.",
}
CROSSOVER = {
    "clover": {"travel":"It also works on the backpack they travel with.", "gym":"It can double as a good-luck charm on their gym bag."},
    "doggo": {"travel":"The dog tag can go on the backpack they take everywhere."},
    "flower": {"gym":"It makes their gym bag easier to recognize."},
}

def profile_read(stories, budget_thb=None):
    groups = {}
    for index, story in enumerate(stories):
        groups.setdefault(story["cue"], []).append(index)
    likes = [{"label":LIKES[cue], "posts":indices} for cue, indices in groups.items() if cue in LIKES]
    labels = [like["label"] for like in likes]
    if not labels:
        headline = "Places they’ve mentioned"
    elif len(stories) == 1:
        headline = "In this post · " + labels[0]
    elif {"race","travel"} <= groups.keys():
        headline = "Race day. One-bag getaway."
    elif {"race","gym"} <= groups.keys():
        headline = "From training days to race day"
    elif len(labels) == 1:
        headline = "From the posts · " + labels[0]
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
            pick["short_reason"] = "A clover for their favorite bag, from race day to the next getaway."
        if pick["item"] in {"clover","doggo","flower"}:
            pick["reason"] += " It’s easy to bring on a coffee date and fits without guessing their size."
        for place in destinations:
            if place["relation"] == "favorite" and any(i in pick["evidence"] and stories[i]["cue"] == "travel" for i in place["posts"]):
                pick["note"] = "Next stop, " + place["name"] + ". Bring this along :)"
                break
    ranked = sorted(groups, key=lambda cue: -len(groups[cue]))
    subjects = [VIBE_TOPICS[cue] for cue in ranked if cue in VIBE_TOPICS
                and (cue != "trip" or "travel" not in groups)]
    if subjects:
        vibe_summary = "These posts show an interest in " + " and ".join(subjects[:2])
    else:
        vibe_summary = "These posts mostly highlight places"
    place_names = list(dict.fromkeys(place["name"] for place in destinations))
    if place_names:
        vibe_summary += ", with mentions of " + " and ".join(place_names[:2])
    return {"headline":headline, "vibe_summary":vibe_summary + ".", "likes":likes,
            "places":destinations, "pick":pick}

DEMO_POSTS = [
    {"cue":"race","caption":"Signed up for my first HYROX! I just want to cross the finish line on Saturday 🥹"},
    {"cue":"travel","caption":"Three days in Chiang Mai and one backpack, as usual. I love coming back to Chiang Mai every winter 🎒",
     "place":{"name":"Chiang Mai","relation":"favorite","excerpt":"I love coming back to Chiang Mai every winter"}},
    {"cue":"gym","caption":"Gym after work. I forgot to pack a change of clothes again 🫠"},
]

PRESENTATION_QUERIES = {"johnmayer": "johnmayer", "oliviadean": "oliviadeano",
                        "oliviadeano": "oliviadeano"}


def resolve_profile_query(query):
    lookup = "".join(query.casefold().split()).removeprefix("@")
    handle = PRESENTATION_QUERIES.get(lookup)
    return f"https://www.instagram.com/{handle}/" if handle else query


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
    "clover": "Tag their luggage so they can spot it quickly.",
    "doggo": "A dog-shaped tag helps their bag stand out on the road.",
}
FITNESS_ALTERNATIVES = {
    "clover": "A clover charm for their training or race bag.",
    "flower": "A bright tag makes their workout bag easy to spot.",
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
            options[item] = catalog_pick(item, budget_thb, "Another option from the catalog.", [])
    for item in options.values():
        if budget_thb is not None and item["price"] > budget_thb:
            item["over_budget_thb"] = item["price"] - budget_thb
    return sorted(options.values(), key=lambda option: (
        not option["eligible"], -len(option.get("evidence", [])), option.get("over_budget_thb", 0),
        (budget_thb-option["price"]) if option.get("catalog_fallback") and option["eligible"] and budget_thb is not None else 0,
    ))[:3]


def catalog_pick(item, budget_thb, reason, evidence):
    product = PRODUCTS[item]
    price = product["price_thb"]
    return {"item": item, "product": product["name"], "brand": product["brand"], "price": price,
            "eligible": budget_thb is None or price <= budget_thb, "reason": reason,
            "short_reason": reason, "note": "Saw this and thought of you.", "evidence": evidence,
            "catalog_fallback": not evidence}


_BAG_REASONS = {
    "aman-jekel-h-messenger": "A messenger bag for keeping everyday travel essentials close.",
    "aman-fames-classic-duffle": "A duffle for packing clothes for a trip.",
    "overhills-motif-windbreaker-jacket": "A windbreaker they can layer on the road.",
    "overhills-rover-pants": "An everyday pair of pants for getting around on a trip.",
    "overhills-resorts-7-shorts": "Light shorts for a warm-weather trip.",
    "overhills-bop-taper-tee": "An easy tee to layer while traveling or wear on a day out.",
    "overhills-airmatte-tee": "A spare tee for a travel day or time outdoors.",
}
_TRAINING_REASONS = {
    "overhills-loadlite-5-shorts": "Training shorts for their next workout.",
    "overhills-grit-pace-45-shorts": "Running shorts for their next training session.",
    "overhills-track-long-sleeve": "A long-sleeve top for warm-ups.",
    "overhills-cool-pace-singlet": "A singlet for training or race day.",
    "overhills-airmatte-tee": "A tee to train in or change into after a workout.",
    "overhills-bop-taper-tee": "A spare tee for their workout rotation.",
}
_LIVE_REASONS = {"race": _TRAINING_REASONS, "gym": _TRAINING_REASONS,
                 "trip": _BAG_REASONS, "travel": _BAG_REASONS, "place": _BAG_REASONS,
                 "music": {
                     "overhills-bop-taper-tee": "An easy tee for rehearsal or time in the studio.",
                     "overhills-airmatte-tee": "A spare tee for a long rehearsal day.",
                 }}

_LIVE_NOTES = {
    "trip": "Your trip made me think of this. Maybe it can come along on the next one.",
    "travel": "For your next one-bag trip. I’d love to hear where you take it.",
    "place": "This made me think of the places you’ve shared. Here’s to the next one.",
    "race": "This made me think of race day. I’m cheering for you.",
    "gym": "I saw this and thought of your after-work workouts. Hope it comes in handy.",
    "music": "This made me think of the music you’ve been sharing. Hope you get some use out of it.",
}


def _gift_rank(gift, post_index=None):
    evidence = gift.get("evidence", [])
    score = gift.get("_fit_score", 55 if evidence else 0)
    return (not gift["eligible"], post_index is not None and post_index not in evidence,
            -score, gift["price"])


def finalize_live_gifts(result):
    for post_index, section in enumerate((result["overview"], *result["stories"]), start=-1):
        options = section.pop("_gift_candidates", None)
        if options is None:
            continue
        scope = None if post_index == -1 else post_index
        section["gifts"] = sorted(options, key=lambda gift: _gift_rank(gift, scope))[:3]
        for gift in section["gifts"]:
            gift.pop("_fit_score", None)
    result["overview"]["pick"] = result["overview"]["gifts"][0]


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
            summary = next((reason for _, reason in matches if reason), "Another option near the budget.")
            reason = summary
            note = "Saw this and thought of you."
            if evidence:
                cue = result["stories"][evidence[0]]["cue"]
                topic = VIBE_TOPICS.get(cue, "the places they shared").lower()
                reason = f"It’s a way to show you noticed {topic}. {summary}"
                note = _LIVE_NOTES.get(cue, note)
            else:
                reason = "This pick is based on price. The posts give little evidence about how it fits their style or activities."
            choices.append({
                "item": item, "product": product["name"], "brand": product["brand"] or "",
                "price": price, "eligible": not overage, "over_budget_thb": overage,
                "image_url": product.get("image_url"), "reason": reason, "short_reason": summary,
                "note": note, "evidence": evidence, "catalog_fallback": not evidence,
            })
        return sorted(choices, key=_gift_rank)[:8]

    stories = result["stories"]
    result["overview"]["_gift_candidates"] = picks(range(len(stories)))
    result["overview"]["gifts"] = result["overview"]["_gift_candidates"][:3]
    result["overview"]["pick"] = result["overview"]["gifts"][0]
    for index, story in enumerate(stories):
        story["_gift_candidates"] = picks([index])
        story["gifts"] = story["_gift_candidates"][:3]
    result["mock_gifts"] = False
    result["catalog_source"] = "merchant"


def build_story(profile_url="", posts=(), demo=False, budget_thb=None):
    network = "Instagram" if demo else platform(profile_url)
    handle = instagram_handle(profile_url) if network == "Instagram" and not demo else None
    if not network or (network == "Instagram" and not demo and not handle):
        return {"status":"need_profile","message":"Share an Instagram or Facebook profile link in chat."}
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
            stories.append({"caption":p["caption"],"cue":"place","title":"Place mentioned","glyph":"📍","eligible":False})
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
        return {"status":"need_post","message":"Share a screenshot or caption in chat so ShopShop can recommend a gift based on their posts."}
    overview = profile_read(stories, budget_thb)
    overview["gifts"] = gift_alternatives(stories, overview["pick"], budget_thb, range(len(stories)))
    overview["pick"] = overview["gifts"][0]
    post_gifts = [gift_alternatives(stories, None, budget_thb, [i]) for i in range(len(stories))]
    for story, gifts in zip(stories, post_gifts):
        story["gifts"] = gifts
    return {"status":"ready","mock_gifts":True,"demo":demo,"profile":"June" if demo else (f"@{handle}" if handle else "Profile"),"network":network,
            "profile_url":None if demo else profile_url,"budget":budget_thb,"stories":stories,"overview":overview}
