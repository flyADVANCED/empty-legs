"""Read empty_legs.json and re-embed the flights array into index.html."""
import json, re, sys

with open("empty_legs.json") as f:
    data = json.load(f)

flights = data["flights"]
scraped_at = data.get("scraped_at", "")

with open("index.html") as f:
    html = f.read()

replacement = "const FLIGHTS = " + json.dumps(flights, separators=(",", ":")) + ";"
html, n = re.subn(r"const FLIGHTS = \[.*?\];", replacement, html, flags=re.DOTALL)

if scraped_at:
    ts_replacement = f'const SCRAPED_AT = "{scraped_at}";'
    html, ts_n = re.subn(r'const SCRAPED_AT = "[^"]*";', ts_replacement, html, flags=re.DOTALL)
    if ts_n == 0:
        html = html.replace("const FLIGHTS =", f'{ts_replacement}\nconst FLIGHTS =', 1)

if n != 1:
    print("ERROR: could not find FLIGHTS constant in index.html", file=sys.stderr)
    sys.exit(1)

with open("index.html", "w") as f:
    f.write(html)

print(f"Injected {len(flights)} flights into index.html")
