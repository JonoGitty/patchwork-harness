// paginate(items, page, size): 1-based pages.
module.exports = function paginate(items, page, size) {
  const start = page * size;
  return items.slice(start, start + size);
};
