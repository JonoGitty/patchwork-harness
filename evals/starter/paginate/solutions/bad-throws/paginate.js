// paginate(items, page, size): 1-based pages.
module.exports = function paginate(items, page, size) {
  if (page < 1) throw new RangeError("page must be >= 1");
  const start = (page - 1) * size;
  if (start >= items.length) throw new RangeError("page past the end");
  return items.slice(start, start + size);
};
