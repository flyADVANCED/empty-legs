import json
import re
import time
from datetime import datetime, timezone
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://client.jetinsight.com/embed/a371a901-ab80-42a4-a429-b10468ba9b1f/empty"
OUTPUT_FILE = "empty_legs.json"
PER_PAGE = 10

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
}


def get_total_pages(soup):
    pages = set()
    for a in soup.select("a[href*='page=']"):
        m = re.search(r"page=(\d+)", a.get("href", ""))
        if m:
            pages.add(int(m.group(1)))
    return max(pages) if pages else 1


def parse_location(text):
    """Parse 'Wings Field (LOM), Pennsylvania' → (airport_name, iata_code, state)"""
    m = re.match(r"^(.+?)\s*\(([A-Z]{3})\),\s*(.+)$", text.strip())
    if m:
        return m.group(1).strip(), m.group(2), m.group(3).strip()
    return text.strip(), None, None


def parse_listings(soup):
    flights = []
    for card in soup.select(".empty-leg-block"):
        flight = {}

        # Image
        img = card.select_one(".img-wrapper img")
        if img:
            flight["image_url"] = img.get("src", "")

        # Location headers (departure then arrival)
        locations = card.select(".location-header")
        if len(locations) >= 1:
            airport, code, state = parse_location(locations[0].get_text(strip=True))
            flight["origin_airport"] = airport
            flight["origin_code"] = code
            flight["origin_state"] = state
        if len(locations) >= 2:
            airport, code, state = parse_location(locations[1].get_text(strip=True))
            flight["destination_airport"] = airport
            flight["destination_code"] = code
            flight["destination_state"] = state

        # Aircraft name
        h3 = card.select_one("h3")
        if h3:
            flight["aircraft"] = h3.get_text(strip=True)

        # Details (calendar=dates, clock=duration, users=seats)
        for detail in card.select(".detail"):
            text = detail.get_text(strip=True)
            icon = detail.select_one("i")
            icon_class = " ".join(icon.get("class", [])) if icon else ""

            if "calendar" in icon_class:
                m = re.search(r"Available\s+(.+)", text)
                if m:
                    dates = m.group(1).strip()
                    parts = [p.strip() for p in dates.split("-")]
                    flight["date_from"] = parts[0] if parts else dates
                    flight["date_to"] = parts[1] if len(parts) > 1 else parts[0]
            elif "clock" in icon_class:
                m = re.search(r"Travel time\s+(.+)", text)
                if m:
                    flight["duration"] = m.group(1).strip()
            elif "users" in icon_class:
                m = re.search(r"Seats\s+(\d+)", text)
                if m:
                    flight["seats"] = int(m.group(1))

        # Price
        h2 = card.select_one("h2")
        if h2:
            flight["price"] = h2.get_text(strip=True)

        # Hidden form fields (aircraft UUID, ICAO origin/destination)
        form = card.select_one("form")
        if form:
            aircraft_uuid = form.select_one("input[name='embedded_leg_request[aircraft_uuid]']")
            origin_icao = form.select_one("input[name='embedded_leg_request[origin]']")
            dest_icao = form.select_one("input[name='embedded_leg_request[destination]']")
            if aircraft_uuid:
                flight["aircraft_uuid"] = aircraft_uuid.get("value", "")
            if origin_icao:
                flight["origin_icao"] = origin_icao.get("value", "")
            if dest_icao:
                flight["destination_icao"] = dest_icao.get("value", "")

        if flight.get("aircraft"):
            flights.append(flight)

    return flights


def crawl():
    all_flights = []
    session = requests.Session()
    session.headers.update(HEADERS)

    print("Fetching page 1...")
    r = session.get(BASE_URL, params={"page": 1, "per_page": PER_PAGE}, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")

    total_pages = get_total_pages(soup)
    print(f"Total pages: {total_pages}")

    flights = parse_listings(soup)
    print(f"  Page 1: {len(flights)} listings")
    all_flights.extend(flights)

    for page in range(2, total_pages + 1):
        time.sleep(0.5)
        print(f"Fetching page {page}...")
        r = session.get(BASE_URL, params={"page": page, "per_page": PER_PAGE}, timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        flights = parse_listings(soup)
        print(f"  Page {page}: {len(flights)} listings")
        all_flights.extend(flights)

    output = {
        "source_url": BASE_URL,
        "scraped_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_listings": len(all_flights),
        "pages_crawled": total_pages,
        "flights": all_flights,
    }

    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2)

    print(f"\nDone. {len(all_flights)} total listings saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    crawl()
