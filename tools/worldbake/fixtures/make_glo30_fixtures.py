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
#
# The rest are the same E008 grid with one thing changed each, for the decoder
# paths the real tiles don't take:
#   none-be.tif      uncompressed, no predictor, big-endian, 16x16 tiles
#   pred1-be.tif     DEFLATE without predictor, big-endian, strips of 10 rows
#   overviews.tif    a COG-like chain: full resolution, then two reduced-
#                    resolution images (NewSubfileType 1) without geotags
#   nodata.tif       declares GDAL_NODATA (tag 42113) "-32767"
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


def report(name, path, t):
    page = t.pages[0]
    print(name, os.path.getsize(path), 'bytes', t.byteorder, 'bigtiff' if t.is_bigtiff else 'classic',
          page.compression, page.predictor, 'tile', page.tilewidth, page.tilelength, 'raster',
          page.geotiff_tags['GTRasterTypeGeoKey'], 'pages', len(t.pages))


def write(name, data, west, compression: str | None = 'zlib', predictor: int | bool = 3, extra=(), **kw):
    path = os.path.join(HERE, name)
    tifffile.imwrite(path, data, photometric='minisblack', compression=compression, predictor=predictor,
                     metadata=None, extratags=geotags(west) + list(extra), **kw)
    with tifffile.TiffFile(path) as t:
        back = t.pages[0].asarray()
        assert np.array_equal(back, data), name
        report(name, path, t)
    return path


def write_overviews(name, data, west):
    """Full resolution first, then 2x and 4x reductions, like a COG's IFD chain."""
    path = os.path.join(HERE, name)
    common = dict(photometric='minisblack', compression='zlib', predictor=3, metadata=None, tile=(16, 16))
    with tifffile.TiffWriter(path, byteorder='<') as tw:
        tw.write(data, extratags=geotags(west), **common)
        tw.write(data[::2, ::2], subfiletype=1, **common)
        tw.write(data[::4, ::4], subfiletype=1, **common)
    with tifffile.TiffFile(path) as t:
        assert np.array_equal(t.pages[0].asarray(), data), name
        assert [p.subfiletype for p in t.pages] == [0, 1, 1], name
        assert [p.shape for p in t.pages] == [(R, C), (R // 2, C // 2), (R // 4, C // 4)], name
        report(name, path, t)


write('glo30-N46_00_E008_00.tif', values(8), 8, byteorder='<', tile=(16, 16))
write('glo30-N46_00_E009_00-bigtiff.tif', values(9), 9, byteorder='<', tile=(16, 16), bigtiff=True)
write('glo30-strips-be.tif', values(8), 8, byteorder='>', rowsperstrip=10)
write('glo30-none-be.tif', values(8), 8, compression=None, predictor=False, byteorder='>', tile=(16, 16))
write('glo30-pred1-be.tif', values(8), 8, predictor=False, byteorder='>', rowsperstrip=10)
write_overviews('glo30-overviews.tif', values(8), 8)
nodata = write('glo30-nodata.tif', values(8), 8, extra=[(42113, 's', 0, '-32767', True)], byteorder='<', tile=(16, 16))
with tifffile.TiffFile(nodata) as t:
    assert t.pages[0].tags[42113].value == '-32767', 'nodata tag'

# LZW (TIFF Compression 5), the codec of the USGS 3DEP and swissALTI3D tiles
# (tools/worldbake/bareGround.mjs). imagecodecs' LZW is libtiff's, so the
# decoder is checked against the early-change code widths libtiff writes.
#   lzw-n42w082.tif  a scaled-down 3DEP 1/3" tile: 12 px per degree with the
#                    6-pixel overlap round the 1-degree cell (24x24 px),
#                    PixelIsArea, NAD83 (4269), nodata "-999999" at row 10, col 10,
#                    LZW + floating-point predictor, 16x16 tiles
#   lzw-noise-be.tif 128x64 float32 noise, big-endian, LZW without predictor,
#                    one strip: 32 KiB of incompressible bytes, so the code
#                    table fills and the encoder sends ClearCode several times
#                    (the raw pixels are in lzw-noise-be.f32, little-endian)
USGS_KEYS = (1, 1, 0, 4,
             1024, 0, 1, 2,      # GTModelType: geographic
             1025, 0, 1, 1,      # GTRasterType: PixelIsArea
             2048, 0, 1, 4269,   # GeographicType: NAD83
             2054, 0, 1, 9102)


def usgs_values():
    j, i = np.mgrid[0:24, 0:24]
    v = (200 + 0.75 * i - 0.5 * j + ((5 * i + 11 * j) % 7) * 0.125).astype(np.float32)
    v[10, 10] = -999999
    return v


usgs = os.path.join(HERE, 'lzw-n42w082.tif')
tifffile.imwrite(usgs, usgs_values(), photometric='minisblack', compression='lzw', predictor=3, metadata=None, byteorder='<', tile=(16, 16),
                 extratags=[(33550, 'd', 3, (1 / 12, 1 / 12, 0.0), True),
                            (33922, 'd', 6, (0.0, 0.0, 0.0, -82 - 6 / 12, 42 + 6 / 12, 0.0), True),
                            (34735, 'H', len(USGS_KEYS), USGS_KEYS, True),
                            (42113, 's', 0, '-999999', True)])
with tifffile.TiffFile(usgs) as t:
    assert np.array_equal(t.pages[0].asarray(), usgs_values()), 'lzw-n42w082'
    report('lzw-n42w082.tif', usgs, t)

noise = np.random.default_rng(20261111).standard_normal((128, 64)).astype(np.float32) * 100
path = os.path.join(HERE, 'lzw-noise-be.tif')
tifffile.imwrite(path, noise, photometric='minisblack', compression='lzw', predictor=False, metadata=None, byteorder='>', rowsperstrip=128)
noise.astype('<f4').tofile(os.path.join(HERE, 'lzw-noise-be.f32'))
with tifffile.TiffFile(path) as t:
    assert np.array_equal(t.pages[0].asarray(), noise), 'lzw-noise-be'
    print('lzw-noise-be.tif', os.path.getsize(path), 'bytes', t.byteorder, t.pages[0].compression, t.pages[0].predictor)
