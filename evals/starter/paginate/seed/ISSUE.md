# Page 1 is missing the first items

`paginate(["a","b","c","d","e"], 1, 2)` returns `["c","d"]` but page 1 should be `["a","b"]`.
Pages are 1-based. Asking for page 0, a negative page, or a page past the end must return `[]`, never throw.
