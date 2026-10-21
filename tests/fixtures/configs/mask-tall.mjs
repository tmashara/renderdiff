/**
 * Masks blocks 50 and 100 of `/tall`: one in each tile of the stitched path, so a mask that
 * only reached the first tile would leave block 100 unpainted.
 */
export default {
  masks: [
    {
      urlPath: "/tall",
      reason: "two blocks of /tall, one per tile",
      locate: (page) => page.locator(".blk:nth-child(50n)"),
    },
  ],
};
