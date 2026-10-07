# Rich menu source

`richmenu.html` is the source of the Thai and English rich menus
(2500×1686), following the Claude Design RichMenu and RichMenuMap boards
(`design/canvas/`). Open it with `?lang=en` for English. Font: Bai Jamjuree
(SIL Open Font License, see `fonts/OFL.txt`). Mascot: `../mascot.jpg`.

Icons come from `../icons-src/icons.mjs`; `data-icon="name"` picks one.
Each `[data-action]` box is a tap area. Re-render after editing:

```bash
npm run richmenu-image
```

That writes `../richmenu.th.png`, `../richmenu.en.png` and the action maps
`../richmenu-areas.th.json` / `.en.json` (`{ data, text, bounds }` per area,
plus `inputOption`, `fillInText` or `liffPath` where used), and refuses
overlapping areas or images over 1 MB. Upload with `npm run rich-menu`.
