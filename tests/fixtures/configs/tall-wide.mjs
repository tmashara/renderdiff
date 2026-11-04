/**
 * Parks a box at x 1,800-2,000 near the top of the right side of `/tall`, so that side scrolls
 * sideways without growing taller: only a shot that keeps the full width shows it.
 */
export default {
  before: (page, { side }) =>
    side === "right" &&
    page.evaluate(() =>
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div style="position:absolute;top:100px;left:1800px;width:200px;height:20px;background:#1f6feb"></div>',
      ),
    ),
};
