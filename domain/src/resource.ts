/**
 * Where a piece of content lives.
 *
 * Skills, Knowledge and Outputs all reference content that may be a string, a
 * file, a URL, or an object in a blob store. The domain names the *reference*
 * and never the storage technology: there is no `s3` or `supabase` variant here,
 * because a domain that knows its storage backend is not storage-independent
 * (see ADR 004). A blob store maps `{ store: 'blob', key }` onto whatever it is.
 */

export type ResourceRef =
  | { store: 'inline'; content: string }
  | { store: 'file'; path: string }
  | { store: 'url'; url: string }
  | { store: 'blob'; key: string };

export type ResourceStore = ResourceRef['store'];

/** Free-form, JSON-safe annotations. Never load-bearing for domain logic. */
export type Metadata = Readonly<Record<string, string | number | boolean>>;

export function describeResource(ref: ResourceRef): string {
  switch (ref.store) {
    case 'inline':
      return `inline(${ref.content.length} chars)`;
    case 'file':
      return `file(${ref.path})`;
    case 'url':
      return `url(${ref.url})`;
    case 'blob':
      return `blob(${ref.key})`;
  }
}
