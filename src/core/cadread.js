// STEP to triangles through the CAD reader (OpenCascade, occt-import-js). No DOM.
// Curved surfaces are cut into triangles no further than 0.01 mm from the true surface,
// the working tolerance everywhere in this app.

/** occt: the started reader. bytes: Uint8Array of a .step/.stp file. Returns a Float32Array
 *  soup in millimetres, every body in the file together (the import repairs and joins them). */
export function stepToTris(occt, bytes, { tol = 0.01 } = {}) {
  const r = occt.ReadStepFile(bytes, { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: tol, angularDeflection: 0.2 });
  if (!r?.success) throw new Error('The STEP file could not be read.');
  let n = 0;
  for (const m of r.meshes) n += m.index ? m.index.array.length : m.attributes.position.array.length / 3;
  if (!n) throw new Error('The STEP file holds no solid or surface to show.');
  const out = new Float32Array(n * 3);
  let k = 0;
  for (const m of r.meshes) {
    const p = m.attributes.position.array, ix = m.index?.array;
    if (ix) for (let i = 0; i < ix.length; i++) { const v = ix[i] * 3; out[k++] = p[v]; out[k++] = p[v + 1]; out[k++] = p[v + 2]; }
    else { out.set(p, k); k += p.length; }
  }
  return out;
}
