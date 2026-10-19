# Workingtitle3D

![Workingtitle3D](box.png)

Workingtitle3D is an offline, 3D modeler designed with 3D printing in mind and built with accessibility options for colorblind users.
Runs in your browser and requires no network connection, login, forced cloud model inspection no telemetry nothing leaves the machine. 

It's new and it will have flaws but it's stable enough and feature rich it's already my daily driver.

Did i mention its free? Now and for as long as it exists no sub, no paid anything ever. 
The whole app lives in an HTML page you can edit and add anything you want to. 

Dedicated add-on module tab is coming so you'll be able to add custom shape tools and share them with each other easily.
There are no automatic or in-app updates. New tools and fixes arrive as new versions, check back often for new revisions we do things fast around here,

As for those tools and features if you find its missing something commonly used in 3D modeling and you think its a good fit, 
submit a request and it likely will be there for the next update. 

I'm just one Man and a silly coding bot in a trenchcoat. If you vehemently hate ai code thats fine, 
don't use it and really don't feel obligated to tell me or anyone else just go enjoy your day and be happy. 

## Features
- Shapes, holes, groups and intersects, joined with exact mesh booleans
  (https://github.com/elalish/manifold).
  
- New shapes follow the pointer and sit flat on whatever face they land on. Parts stay on a
  0.05 mm lattice, so parts that meet really meet and you don't end up with un-joined slivers.
  
- Parametric: Change a hole after grouping it and the group rebuilds. Every part keeps its record.
- Undo: Roll back a single part of a group and it rebuilds the group with the updated shape (feature not seen before) of the one part and leave the rest alone.
- Supports STL, 3MF and OBJ, repaired automagically during import. Repairing does not always fully close a mesh but,
- it'll load the model in anyway and you can continue on no complaints.
- Export: has its own set of repair options, which will (should) take care of any remaining manifold issues.
- 
- Show faults: check box lets you see where model defects are by highlighting them.
- Repair: weld gaps, fill holes, or rebuild the mesh as one solid.
- Simplify: Quadratic edge collapse decimation with topology preserve, fewer triangles and a smaller file.
- Edge shaper: fillet, chamfer, cove on flats.
- Hollow, optionally opened through a face.
- Save file writes the whole project as one .wt3d file. Parts stay editable, imported meshes
  stay exact, so nothing degrades on a round trip the way it does witch a STL.
- tooltips: View menu - toggle tooltips, Helpful messages when you hover oven an item to help you get started without having to RTFM.
- Interface Theme: includes multiple color scheme presets to help with different types of colorblindness. Cant find a color scheme to suite your needs?
- Submit a request with color hex codes and say which color you'd like swapped for which and the color scheme currently loaded its an easy way to describe it,
- See ACCESSIBILITY.md.

## Run
Download the latest release - open Workingtitle3D.html in a Chromium-based browser (Chromium itself is preferred,
Vivaldi and Brave also good options). There is no install no bloat. Firefox and Safari work too: there auto save keeps
your project inside the browser on that computer, and Save file writes a copy you can keep anywhere.

Brave keeps folder access switched off by default, so out of the box it auto saves inside the browser like Firefox.
To have auto save write to a real folder instead, go to the address bar and input brave://flags/#file-system-access-api
select enable and launch Workingtitle3D easy as. Either way auto save really is a must the software is not perfect non
of them ever are but with auto save if there's ever a crash, reload the page and File > Reopen puts everything back how
you left it, with the option to undo the last action first in case that is what crashed it.

To build it yourself:

    npm install
    npm run build

## Keys
| Key | Action |
|---|---|
| Right drag / middle drag / wheel | orbit / pan / zoom to the pointer |
| Ctrl + left drag | orbit |
| Left drag on a part / empty space | move on the plate / select box |
| Shift + click | add to selection |
| Arrows, Ctrl + Up/Down | nudge 1 mm (Shift: 10 mm) following the view, raise / lower |
| Alt + drag | drag a copy |
| Hold R | rotate rings |
| Shift + F, click a face | slide the selected part along that face with the arrows |
| F | fit the selection |
| H / S | hole / solid |
| D | drop to the plate |
| M | mirror X (Shift: Y, Alt: Z) |
| Ctrl + G / Ctrl + Shift + G / Ctrl + I | group / ungroup / intersect |
| Ctrl + D | duplicate (repeats the last offset) |
| Ctrl + C / X / V | copy / cut / paste |
| Ctrl + H / Ctrl + Shift + H | hide / show hidden |
| Ctrl + L | lock |
| Ctrl + Z / Ctrl + Y | undo / redo |
| Ctrl + E | export |
| Delete, Esc | delete, clear selection |

## Tests
    node tests/kernel.mjs         shapes, groups, tool steps, joined export
    node tests/doc.mjs            history, rollback, project folder, crash recovery
    node tests/tools_repair.mjs   repair, make solid, open meshes in groups and cuts
    node tests/simplify.mjs       simplify stays within its surface limit
    node tests/walk.mjs           every function of the built page, headless
    node tests/browser.mjs        the built page, headless

The two browser tests need PUPPETEER_DIR and CHROME_DIR set.

## Licence
Free and open source: GNU Affero General Public License, version 3 or later
(AGPL-3.0-or-later). Use it, study it, change it and share it, for personal and commercial
work alike. If you pass on a changed version, or let people use one over a network, you must
offer them its full source under the same licence. Full terms in LICENSE; the notice in NOTICE.

The models you make are yours alone to keep, sell or otherwise do as you please. The licence
does not cover them.

Source: https://github.com/bootdsc/Workingtitle3D (the built HTML file is minified; this
repository is its source).

Versions up to 0.1.1 were released under Apache License 2.0 with the Commons Clause, and
copies of those keep those terms. Later versions are under AGPL-3.0-or-later.

Bundled libraries keep their own licences: MIT, Apache-2.0, ISC and Boost 1.0, and LGPL-2.1
for the STEP reader (occt-import-js, with Open CASCADE Technology). They are listed in
THIRD-PARTY-NOTICES.txt, which is carried inside the built HTML file.

## Acknowledgements
Designed by Bootdsc, encabulated by Claude.
Built at the Cyberdeck Cafe Workshop. https://cyberdeck.cafe/
