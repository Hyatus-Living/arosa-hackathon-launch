import React from 'react';
export default function Image({src, alt = '', width, height, fill, priority, unoptimized, loader, quality, placeholder, blurDataURL, ...rest}) {
  return <img src={typeof src === 'string' ? src : src?.src} alt={alt} width={width} height={height} {...rest} />;
}
