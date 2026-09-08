# Rich menu source

`richmenu.html` is the source of `../richmenu.png` (2500×1686). Font: Bai Jamjuree
(SIL Open Font License, see `fonts/OFL.txt`). Mascot: `../mascot.jpg`.

The tile icons come from `../icons-src/icons.mjs` (the same set the chat cards
use); `data-icon="name"` on a tile picks one. Re-render after editing:

```bash
npm run richmenu-image
```

Then upload with `npm run rich-menu` (or re-run `./scripts/setup.sh`).
