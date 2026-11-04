/** Parks a box 20,000px to the right on `/tall`, so the stitch would be 20,200×18,000. */
export default {
  before: (page) =>
    page.evaluate(() =>
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div style="position:absolute;top:0;left:20000px;width:200px;height:20px"></div>',
      ),
    ),
};
