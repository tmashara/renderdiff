// Past Chromium's one-shot cap, so the same motion goes through the tiled path.
export default {
  before: (page) =>
    page.evaluate(() =>
      document.body.insertAdjacentHTML("beforeend", '<div style="height:17000px"></div>'),
    ),
};
