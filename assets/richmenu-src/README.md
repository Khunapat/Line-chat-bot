# Rich menu source

`richmenu.html` is the source of `../richmenu.png` (2500×1686). Font: Bai Jamjuree
(SIL Open Font License, see `fonts/OFL.txt`). Mascot: `../mascot.jpg`.

Re-render after editing (any headless Chromium works):

```bash
chrome --headless=new --hide-scrollbars --window-size=2500,1686 \
  --screenshot=../richmenu.png richmenu.html
```

Then upload with `npm run rich-menu` (or re-run `./scripts/setup.sh`).
