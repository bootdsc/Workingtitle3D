// Settings checks shared by the panel and the compute.

export function problem(p) {
  if (!(p.wall > 0)) return 'The wall must be above zero.';
  if (!(p.voxel > 0)) return 'The detail must be above zero.';
  return null;
}
