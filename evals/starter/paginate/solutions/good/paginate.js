// paginate(items, page, size): 1-based pages.
module.exports = function paginate(items, page, size) {
  if (page < 1) return [];
  const start = (page - 1) * size;
  return items.slice(start, start + size);
};
