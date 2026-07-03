/**
 * Orders backend segment ids of the form `e{epoch}:seg-{ordinal}` (pipeline ASR)
 * or `e{epoch}:ast-{ordinal}` (interpret AST). Returns <0 if `a` is older than
 * `b`, >0 if newer, 0 if equal precedence. A later reconnect epoch is always
 * newer than an earlier one (ordinals reset per connection); an id that does not
 * parse is treated as (0,0) so it never wrongly outranks a real segment. Used to
 * keep the overlay's current line monotonic even though the backend now emits
 * every final (including a slow-translated older one). A session is uniformly
 * one id shape, so ordering only ever compares same-shape ids.
 */
export function compareSegmentId(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa.epoch !== pb.epoch) {
    return pa.epoch - pb.epoch;
  }
  return pa.ordinal - pb.ordinal;
}

function parse(segmentId: string): { epoch: number; ordinal: number } {
  const match = /^e(\d+):(?:seg|ast)-(\d+)$/.exec(segmentId);
  if (match === null) {
    return { epoch: 0, ordinal: 0 };
  }
  return { epoch: Number(match[1]), ordinal: Number(match[2]) };
}
