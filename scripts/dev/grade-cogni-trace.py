#!/usr/bin/env python3
"""Grade one Cogni run for systematic knowledge gathering from its Langfuse trace.

Usage: grade-cogni-trace.py <traceId>
Reads LANGFUSE_* from the environment (source .env.local first).
Mirrors packages/langgraph-graphs/evals/cogni/coverage-grader.ts (bug.5542).
"""
import base64, json, os, sys, urllib.request

TRACE = sys.argv[1] if len(sys.argv) > 1 else sys.exit("need traceId")
BASE = os.environ["LANGFUSE_BASE_URL"].rstrip("/")
AUTH = base64.b64encode(
    f'{os.environ["LANGFUSE_PUBLIC_KEY"]}:{os.environ["LANGFUSE_SECRET_KEY"]}'.encode()
).decode()


def get(path):
    r = urllib.request.Request(BASE + path, headers={"Authorization": "Basic " + AUTH})
    return json.load(urllib.request.urlopen(r, timeout=30))


obs = sorted(
    get(f"/api/public/observations?traceId={TRACE}&limit=100").get("data", []),
    key=lambda o: o.get("startTime") or "",
)


def as_obj(v):
    if isinstance(v, str):
        try:
            return json.loads(v)
        except Exception:
            return {}
    return v if isinstance(v, dict) else {}


# Correlate tool_calls (from generation outputs) with tool results (from later inputs).
calls = {}  # tool_call_id -> {name, args}
results = {}  # tool_call_id -> content(str)
proposal = None
for o in obs:
    out = as_obj(o.get("output"))
    msg = out.get("message") if isinstance(out.get("message"), dict) else out
    for c in (msg or {}).get("tool_calls") or []:
        fn = c.get("function") or {}
        args = fn.get("arguments")
        args = as_obj(args) if isinstance(args, str) else (args or {})
        calls[c.get("id")] = {"name": fn.get("name"), "args": args}
    # a structured Proposal may appear as the final output
    cand = out if isinstance(out, dict) else {}
    if cand.get("items") is not None and cand.get("summary") is not None:
        proposal = cand
    inp = as_obj(o.get("input"))
    for m in inp.get("messages") or []:
        if isinstance(m, dict) and m.get("role") == "tool" and m.get("tool_call_id"):
            results[m["tool_call_id"]] = str(m.get("content") or "")

FULL_READ = {"core__work_item_read", "core__knowledge_read", "core__node_code_read"}
events = []
for cid, call in calls.items():
    name, args = call["name"], call["args"]
    content = results.get(cid, "")
    ok = bool(content) and '"error"' not in content[:200].lower()
    body = as_obj(content)
    full = False
    cid_val = None
    if name == "core__work_item_read":
        item = body.get("item") or {}
        full = body.get("complete") is True and bool(item)
        cid_val = item.get("id") or args.get("id")
    elif name == "core__knowledge_read":
        full = '"content"' in content and (args.get("id") is not None or body.get("mode") == "get")
        cid_val = args.get("id")
    elif name == "core__node_code_read":
        full = body.get("complete") is True and "content" in body
        cid_val = body.get("citation")
    events.append({"name": name, "ok": ok, "fullBody": full, "id": cid_val})

PLANES = {
    "goals": lambda e: e["name"] == "core__goal_list" and e["ok"],
    "knowledge": lambda e: e["name"] == "core__knowledge_read" and e["ok"] and e["fullBody"],
    "inbox": lambda e: e["name"] == "core__knowledge_contribution_read" and e["ok"],
    "work": lambda e: e["name"] == "core__work_item_read" and e["ok"] and e["fullBody"],
    "git": lambda e: e["name"] == "core__node_code_read" and e["ok"] and e["fullBody"],
}
hit = [p for p, f in PLANES.items() if any(f(e) for e in events)]
missed = [p for p in PLANES if p not in hit]
coverage = len(hit) / len(PLANES)
full_ids = {e["id"] for e in events if e["ok"] and e["fullBody"] and e["name"] in FULL_READ and e["id"]}
cited = sorted({s for it in (proposal or {}).get("items", []) for s in it.get("sourceIds", [])})
cited_unread = [c for c in cited if c not in full_ids]
grounding = (len(cited) - len(cited_unread)) / len(cited) if cited else 1.0
if not events:
    grade = "unscorable (no tool events)"
elif proposal is None:
    grade = "unscorable (no final proposal in trace)"
else:
    grade = "pass" if coverage == 1 and grounding == 1 else "fail"

print(f"trace {TRACE}")
print(f"  generations={len(obs)} tool_calls={len(calls)} tool_results={len(results)}")
print(f"  distinct tools used: {sorted({e['name'] for e in events})}")
print(f"  planes hit: {hit}   missed: {missed}")
print(f"  COVERAGE = {coverage:.2f}   GROUNDING = {grounding:.2f}")
print(f"  cited sources: {cited}   cited-but-unread: {cited_unread}")
print(f"  GRADE = {grade}")
