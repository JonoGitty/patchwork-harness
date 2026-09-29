# slugify(input) rules

1. Lowercase everything.
2. Accented letters become their plain ASCII letter (é -> e, ü -> u).
3. Spaces and underscores become hyphens.
4. Drop every character that is not a-z, 0-9 or a hyphen.
5. Collapse runs of hyphens into one.
6. No leading or trailing hyphens.
7. Non-string input throws a TypeError.
