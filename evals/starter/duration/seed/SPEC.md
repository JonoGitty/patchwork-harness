# parseDuration(s) rules

- Units: h (hours), m (minutes), s (seconds). Units are case-insensitive.
- Parts may be separated by spaces: "1h 30m" is 5400.
- A bare number is seconds: "90" is 90.
- Units may repeat in any order and add up: "30m1h" is 5400.
- Empty strings, unknown units and negative numbers throw an Error.
