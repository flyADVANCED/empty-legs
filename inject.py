"""Read empty_legs.json and re-embed flights + metadata into index.html."""
import json, re, sys

with open("empty_legs.json") as f:
    data = json.load(f)

flights = data["flights"]
last_crawled_at = data.get("last_crawled_at", "")

with open("index.html") as f:
    html = f.read()

flights_js = "const FLIGHTS = " + json.dumps(flights, separators=(",", ":")) + ";"
html, n = re.subn(r"const FLIGHTS = \[.*?\];", flights_js, html, flags=re.DOTALL)
if n != 1:
    print("ERROR: could not find FLIGHTS constant in index.html", file=sys.stderr)
    sys.exit(1)

if last_crawled_at:
    ts_js = f'const LAST_CRAWLED_AT = "{last_crawled_at}";'
    html, m = re.subn(r'const LAST_CRAWLED_AT = "[^"]*";', ts_js, html)
    if m == 0:
        html = html.replace("const FLIGHTS =", ts_js + "\n      const FLIGHTS =", 1)

with open("index.html", "w") as f:
    f.write(html)

print(f"Injected {len(flights)} flights into index.html (crawled {last_crawled_at})")
