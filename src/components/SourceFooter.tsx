import { sourceUrl, sourceVersion } from '../lib/hosted';

export function SourceFooter() {
  return (
    <a className="source-link" href={sourceUrl()} target="_blank" rel="noreferrer">
      源码 AGPL-3.0 · {sourceVersion()}
    </a>
  );
}
