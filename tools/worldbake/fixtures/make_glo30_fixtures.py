# Writes the GLO-30 decoder fixtures used by src/lib/world/glo30.test.ts.
# They are made with tifffile + imagecodecs (libtiff-compatible DEFLATE and
# floating-point predictor), an implementation independent of
# tools/worldbake/geotiff.mjs, so the test checks our decoder against theirs.
#
#   uv run --with numpy --with tifffile --with imagecodecs \
#     python tools/worldbake/fixtures/make_glo30_fixtures.py
#
# The two tiles are scaled-down GLO-30 tiles at N46 E008 and N46 E009: R = 36
# rows and C = 24 columns per degree (a 1.5x reduced-longitude band, like the
# real 50-60 degree tiles), PixelIsPoint, tiepoint on the NW corner, 16x16
# internal tiles (edge tiles padded), little-endian. E008 is classic TIFF,
# E009 BigTIFF. strips-be.tif is the same E008 grid big-endian and stripped.
import os
import numpy as np
import tifffile

R, C = 36, 24
HERE = os.path.dirname(os.path.abspath(__file__))


def values(west):
    """Exact in float32: multiples of 1/8 m, negative in the south-east."""
    j, i = np.mgrid[0:R, 0:C]
    return ((west - 8) * 100 + 10 + 1.5 * i - 2.25 * j + ((7 * i + 3 * j) % 5) * 0.125).astype(np.float32)


GEOKEYS = (1, 1, 0, 4,
           1024, 0, 1, 2,      # GTModelType: geographic
           1025, 0, 1, 2,      # GTRasterType: PixelIsPoint
           2048, 0, 1, 4326,   # GeographicType: WGS 84
           2054, 0, 1, 9102)   # angular units: degree


def geotags(west):
    return [
        (33550, 'd', 3, (1 / C, 1 / R, 0.0), True),
        (33922, 'd', 6, (0.0, 0.0, 0.0, float(west), 47.0, 0.0), True),
        (34735, 'H', len(GEOKEYS), GEOKEYS, True),
    ]


def write(name, data, west, **kw):
    path = os.path.join(HERE, name)
    tifffile.imwrite(path, data, photometric='minisblack', compression='zlib', predictor=3,
                     metadata=None, extratags=geotags(west), **kw)
    with tifffile.TiffFile(path) as t:
        page = t.pages[0]
        back = page.asarray()
        assert np.array_equal(back, data), name
        print(name, os.path.getsize(path), 'bytes', t.byteorder, 'bigtiff' if t.is_bigtiff else 'classic',
              page.compression, page.predictor, 'tile', page.tilewidth, page.tilelength, 'raster',
              page.geotiff_tags['GTRasterTypeGeoKey'])


write('glo30-N46_00_E008_00.tif', values(8), 8, byteorder='<', tile=(16, 16))
write('glo30-N46_00_E009_00-bigtiff.tif', values(9), 9, byteorder='<', tile=(16, 16), bigtiff=True)
write('glo30-strips-be.tif', values(8), 8, byteorder='>', rowsperstrip=10)
