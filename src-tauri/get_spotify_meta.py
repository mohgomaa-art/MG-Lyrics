import sys
import urllib.request
import re
import json

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No URL provided"}))
        return
    url = sys.argv[1]
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
        with urllib.request.urlopen(req, timeout=10) as response:
            html = response.read().decode('utf-8')
        
        title_match = re.search(r'<meta property="og:title" content="([^"]+)"', html) or re.search(r'<title>([^<]+)</title>', html)
        image_match = re.search(r'<meta property="og:image" content="([^"]+)"', html)
        desc_match = re.search(r'<meta property="og:description" content="([^"]+)"', html)
        
        title = title_match.group(1) if title_match else "Unknown Title"
        image = image_match.group(1) if image_match else ""
        desc = desc_match.group(1) if desc_match else ""
        
        # HTML unescape
        title = title.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'")
        
        artist = "Unknown Artist"
        if desc:
            # E.g. "Song · Artist · Year" or "Playlist · Name · Songs"
            parts = desc.split(" · ")
            if len(parts) > 1:
                # Typically Spotify puts "Song · Artist · 2020" or similar
                # Let's inspect parts.
                # If parts[0] is "Song", then parts[1] is the artist name.
                # E.g. "Song · The Weeknd · 2020" -> artist is The Weeknd
                if "song" in parts[0].lower():
                    artist = parts[1]
                else:
                    artist = parts[0]
            else:
                artist = desc
        
        # Clean artist if it contains Spotify text
        artist = artist.replace("Listen to ", "").replace(" on Spotify", "").strip()
        if "Spotify. " in artist:
            artist = artist.split("Spotify. ")[1]
            
        print(json.dumps({
            "title": title,
            "image": image,
            "artist": artist
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
