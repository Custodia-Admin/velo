/**
 * A photographic plate: a still of the place, no border, no frame
 * (v2-identity §2.1). Text never sits directly on it; labels go on paper.
 * Day/night variants follow the theme class; an optional portrait crop is
 * used below `sm`.
 */

import { cn } from '@/lib/utils';

export interface PlateProps {
  src: string;
  /** Blue-hour variant shown in the night theme. */
  nightSrc?: string;
  /** Portrait crop for phones (< sm). */
  portraitSrc?: string;
  /** Empty for decorative plates (the tile's text names the place). */
  alt: string;
  /** Aspect / size classes, e.g. "aspect-video max-h-hero-fit". */
  className?: string;
  /** Eager for the above-the-fold hero, lazy elsewhere. */
  priority?: boolean;
}

export function Plate({ src, nightSrc, portraitSrc, alt, className, priority = false }: PlateProps) {
  const loading = priority ? 'eager' : 'lazy';
  const img = (url: string, extra?: string) => (
    <picture className={cn('contents', extra)}>
      {portraitSrc && <source media="(max-width: 39.99rem)" srcSet={portraitSrc} />}
      <img
        src={url}
        alt={alt}
        loading={loading}
        decoding="async"
        className="block h-full w-full object-cover"
      />
    </picture>
  );
  return (
    <div className={cn('relative overflow-hidden rounded-lg bg-muted', className)}>
      {nightSrc ? (
        <>
          <div className="h-full w-full dark:hidden">{img(src)}</div>
          <div className="hidden h-full w-full dark:block">{img(nightSrc)}</div>
        </>
      ) : (
        img(src)
      )}
    </div>
  );
}
