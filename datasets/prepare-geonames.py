# SPDX-License-Identifier: AGPL-3.0-only
"""Build the offline reverse-geocoder bundle (T14 Library location filter) from GeoNames (CC BY 4.0).

Inputs (store): datasets/geonames/cities15000.zip and countryInfo.txt, downloaded from
https://download.geonames.org/export/dump/. Output (repo): apps/web/src/media/places.json.
Each place keeps only its name, country code and coordinates rounded to 0.01 degree; city sections are dropped.
"""
import io
import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path(os.environ['CUTFRAME_FIXTURES']) / 'datasets/geonames'
OUT = ROOT / 'apps/web/src/media/places.json'

def main():
    countries = {}
    for line in (SRC / 'countryInfo.txt').read_text(encoding='utf-8').splitlines():
        if line and not line.startswith('#'):
            cols = line.split('\t')
            countries[cols[0]] = cols[4]
    rows = []
    with zipfile.ZipFile(SRC / 'cities15000.zip') as z:
        for line in io.TextIOWrapper(z.open('cities15000.txt'), encoding='utf-8'):
            c = line.rstrip('\n').split('\t')
            name, lat, lon, cc, code = c[1], round(float(c[4]) * 100), round(float(c[5]) * 100), c[8], c[7]
            # Sections of cities (PPLX, e.g. "Financial District") and historical/abandoned places are not city names.
            if code in ('PPLX', 'PPLH', 'PPLQ', 'PPLW', 'PPLCH'): continue
            if cc in countries and '\t' not in name and '|' not in name:
                rows.append(f'{name}|{cc}|{lat}|{lon}')
    rows.sort()
    bundle = {'source': 'GeoNames cities15000 + countryInfo, https://download.geonames.org/export/dump/', 'licence': 'CC-BY-4.0',
              'attribution': 'GeoNames (geonames.org), CC BY 4.0', 'scale': 100,
              'countries': {k: countries[k] for k in sorted(countries)}, 'places': '\n'.join(rows)}
    OUT.write_text(json.dumps(bundle, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8', newline='\n')
    print(f'{len(rows)} places, {len(countries)} countries, {OUT.stat().st_size} bytes')

if __name__ == '__main__': main()
