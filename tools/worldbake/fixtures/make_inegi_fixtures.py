# Writes the INEGI MDT fixtures used by src/lib/world/bareGround.test.ts.
# They are made with Python's zipfile and pyproj (PROJ), implementations
# independent of tools/worldbake/inegiMdt.mjs (zip reader, Krüger series), so
# the test checks ours against theirs.
#
#   uv run --with numpy --with pyproj python tools/worldbake/fixtures/make_inegi_fixtures.py
#
# inegi-F13C69A4-coarse_b.zip: sheet F13C69A4 (20.625–20.6875° N,
# 105.2778–105.2222° W) laid out like INEGI's product zips (backslash member
# paths, a metadatos folder, the real sheets' WGS 84 UTM 13N .prj), but with
# 100 m pixels instead of 5 m so the raster covers the whole cell in a few KB.
# Pixel centres sit on E = 50 + 100 i, N = 50 + 100 j; the value at (E, N) is
# value(E, N) below, exact in float32; one pixel is nodata, one row of the
# south margin is 0.0 (INEGI's sea fill). The bil member is deflated, the hdr
# stored, so the reader's two methods are both exercised.
#
# inegi-F13C69A4-points.json: test points (lat, lon) with pyproj's UTM 13N
# (E, N), the pixel that holds each, and its value; plus pyproj's UTM for
# points in zones 11 and 16 (the Krüger series away from zone 13).
import json, os, zipfile
import numpy as np
from pyproj import Transformer

HERE = os.path.dirname(os.path.abspath(__file__))
PRJ = ('PROJCS["WGS_1984_UTM_Zone_13N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],'
       'PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],'
       'PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-105.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]')
NODATA = np.float32(-3.4028231e38)
X0, Y0, NC, NR = 470550.0, 2288050.0, 72, 82  # centre of the upper-left pixel; 100 m pixels


def value(e, n):
    """Exact in float32: multiples of 1/8 m."""
    i = round((e - 50) / 100)
    j = round((n - 50) / 100)
    return np.float32(3 + (i % 40) * 0.25 + (j % 30) * 0.125 + ((7 * i + 3 * j) % 5) * 0.125)


def main():
    a = np.empty((NR, NC), dtype='<f4')
    for r in range(NR):
        for c in range(NC):
            a[r, c] = value(X0 + 100 * c, Y0 - 100 * r)
    a[40, 30] = NODATA
    a[NR - 1, :] = 0.0
    hdr = '\n'.join([
        'BYTEORDER      I', 'LAYOUT         BIL', f'NROWS          {NR}', f'NCOLS          {NC}', 'NBANDS         1', 'NBITS          32',
        f'BANDROWBYTES   {NC * 4}', f'TOTALROWBYTES  {NC * 4}', 'PIXELTYPE      FLOAT', f'ULXMAP         {X0}', f'ULYMAP         {Y0}',
        'XDIM           100', 'YDIM           100', 'NODATA         -3.4028231e+038', '']).replace('\n', '\r\n')
    out = os.path.join(HERE, 'inegi-F13C69A4-coarse_b.zip')
    with zipfile.ZipFile(out, 'w') as z:
        def add(name, data, method):
            info = zipfile.ZipInfo(name, date_time=(2014, 1, 1, 0, 0, 0))
            info.compress_type = method
            z.writestr(info, data)
        add('conjunto_de_datos\\f13c69a4_mt.bil', a.tobytes(), zipfile.ZIP_DEFLATED)
        add('conjunto_de_datos\\f13c69a4_mt.hdr', hdr.encode('latin1'), zipfile.ZIP_STORED)
        add('conjunto_de_datos\\f13c69a4_mt.prj', PRJ.encode('latin1'), zipfile.ZIP_DEFLATED)
        add('metadatos\\f13c69a4_mt_ntm_a.txt', 'Fixture: not an INEGI product.\r\n'.encode('latin1'), zipfile.ZIP_DEFLATED)

    utm13 = Transformer.from_crs('EPSG:4326', 'EPSG:32613', always_xy=True)
    pts = []
    for lat, lon in [(20.65625, -105.25), (20.6261, -105.2770), (20.6870, -105.2230), (20.6402, -105.2391), (20.6713, -105.2655)]:
        e, n = utm13.transform(lon, lat)
        c = int(np.floor((e - (X0 - 50)) / 100))
        r = int(np.floor(((Y0 + 50) - n) / 100))
        pts.append({'lat': lat, 'lon': lon, 'E': round(e, 4), 'N': round(n, 4), 'col': c, 'row': r, 'value': float(a[r, c])})
    other = []
    for zone, lat, lon in [(11, 32.5, -117.0), (16, 21.1, -86.85), (13, 20.0, -108.0), (13, 33.0, -102.0)]:
        t = Transformer.from_crs('EPSG:4326', f'EPSG:{32600 + zone}', always_xy=True)
        e, n = t.transform(lon, lat)
        other.append({'zone': zone, 'lon0': -183 + 6 * zone, 'lat': lat, 'lon': lon, 'E': round(e, 4), 'N': round(n, 4)})
    with open(os.path.join(HERE, 'inegi-F13C69A4-points.json'), 'w') as f:
        json.dump({'sheet': 'F13C69A4', 'x0': X0, 'y0': Y0, 'cols': NC, 'rows': NR, 'pixel': 100, 'nodata': [30, 40], 'points': pts, 'utm': other}, f, indent=1)
        f.write('\n')
    print(out, os.path.getsize(out))


main()
