// hollower panel: hollow a closed model to a set wall, optionally open through one face.
import { problem } from './limits.js';

// one box for the grid resolution (presets beside a box that takes any value were redundant)
export function gridPicker(ui, value, set) {
  return [ui.tip(ui.numfield('Detail', value, 'mm', v => set(v), { min: 0.001, step: 0.05, digits: 3, lazy: true }), 'The grid size the inside is worked out on: smaller is finer, slower and uses more memory')];
}

export default {
  id: 'hollower',
  title: 'Hollow',
  blurb: 'Hollow a closed model to a set wall. Click flat faces on the outside to open it through them, as many as you like; click one again to close it.',
  suffix: 'hollow',
  live: false,
  needsFace: true,
  multiFace: true,   // every face clicked is an opening; none is a closed hollow
  defaults: { wall: 2.4, voxel: 0.2 },
  stepLabel: p => `Hollow, wall ${p.wall} mm`,

  validate(p) { return problem(p) || null; },

  panel(el, api) {
    const { ui, params: p } = api;
    const faceLine = ui.h('div', { class: 'note' });
    const update = () => {
      const s = api.selection();
      const k = s?.faces?.length || 0;
      faceLine.textContent = k ? `${k} opening${k > 1 ? 's' : ''} (${s.area.toFixed(1)} mm2). Click a face again to close it.` : 'Closed. Click faces to open it.';
    };
    el.append(
      ui.numfield('Wall thickness', p.wall, 'mm', v => api.set('wall', v), { min: 0.001, step: 0.2, digits: 3 }),
      ...gridPicker(ui, p.voxel, v => api.set('voxel', v)),
      faceLine,
    );
    update();
    return { update };
  },
};
