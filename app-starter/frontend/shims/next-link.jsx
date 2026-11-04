import React from 'react';
export default function Link({href, children, prefetch, replace, scroll, shallow, ...rest}) {
  return <a href={typeof href === 'string' ? href : href?.pathname || '#'} {...rest}>{children}</a>;
}
