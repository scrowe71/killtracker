"""Build public/data/systems.json (every solar system in EVE) from public ESI.
Run again after CCP adds systems/regions:  python tools/gen_systems.py public/data
Output: {"regions": {id: name}, "systems": {id: [name, regionId, trueSec]}}
"""
import json, sys, time, urllib.request, concurrent.futures as cf
ESI = "https://esi.evetech.net/latest"
def get(path):
    for i in range(6):
        try:
            with urllib.request.urlopen(ESI + path, timeout=30) as r:
                return json.load(r)
        except Exception as e:
            err = e; time.sleep(1 + i * 2)
    raise err
out = sys.argv[1]
region_ids = get("/universe/regions/")
with cf.ThreadPoolExecutor(16) as ex:
    regions = list(ex.map(lambda r: get(f"/universe/regions/{r}/"), region_ids))
const_region = {c: r["region_id"] for r in regions for c in r.get("constellations", [])}
with cf.ThreadPoolExecutor(24) as ex:
    consts = list(ex.map(lambda c: get(f"/universe/constellations/{c}/"), const_region))
sys_region = {s: c["region_id"] for c in consts for s in c.get("systems", [])}
with cf.ThreadPoolExecutor(32) as ex:
    systems = list(ex.map(lambda s: get(f"/universe/systems/{s}/"), sys_region))
data = {
    "regions": {r["region_id"]: r["name"] for r in regions},
    "systems": {s["system_id"]: [s["name"], sys_region[s["system_id"]], round(s.get("security_status", 0), 4)] for s in systems},
}
json.dump(data, open(f"{out}/systems.json", "w"), separators=(",", ":"))
print(len(data["regions"]), "regions", len(data["systems"]), "systems")
