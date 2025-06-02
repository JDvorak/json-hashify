# JSON-Hashify

[![npm package](https://nodei.co/npm/json-hashify.png?downloads=true&stars=true)](https://nodei.co/npm/json-hashify/)

JSON Structural Hashing.

Everyone has JSON! Do you need to know if your JSON is *structurally* and faintly semantically similar to other JSON? Not just `===` identical, but close in shape and content? We got you!

This utility takes any JSON object/array, analyzes its structure and content (paths, values, subtrees), generates k-shingles from these features, and then applies Grouped One Permutation Hashing ([Grouped-OPH](https://www.npmjs.com/package/grouped-oph)) to produce a compact signature ("sketch").

Compare sketches to estimate Jaccard similarity. Fast and effective for detecting structural likeness, perfect for use in an Approximate Nearest Neighbor graph for ASTs, Code Similarity, or More.

## Usage

Simple:

```javascript
import { JSONHashify, generateJSONHashifySketch, compareJSONHashifySketches, estimateJaccardSimilarity } from 'json-hashify'; 

// Your JSONs
const json1 = { a: 1, b: { c: 2, d: [3, 4] }, e: "hello" };
const json2 = { a: 1, b: { c: 99, d: [3, 4] }, e: "world" }; // similar structure, different values
const json3 = { x: true, y: false, z: null }; // totally different

// Make a hasher instance (or don't, use the utility fns)
const hasher = new JSONHashify({
  shingleSize: 5,         // Default: 5. Size of k-shingles for path:value strings.
  subtreeDepth: 2,        // Default: 2. How deep to look into subtrees.
  frequencyThreshold: 1,  // Default: 1. Min times a shingle must appear.
  numHashFunctions: 128,  // Default: 128. Total hashes in the sketch.
  numGroups: 4,           // Default: 4. Groups for GOPH. numHashFunctions must be divisible by this.
  preserveArrayOrder: true, // Default: true. `arr[0]` vs `arr[1]`. If false, array elements are like a bag.
  ignoreKeys: ['position'], // Default: []. Keys to completely ignore.
  enableNodeStringCache: true, // Default: false. Cache shingle sets for node strings? Speeds up repeats.
  nodeStringCacheSize: 5000  // Default: 1000. Max items in node string cache if enabled.
});

const sketch1 = hasher.generateSketch(json1);
const sketch2 = hasher.generateSketch(json2);
const sketch3 = hasher.generateSketch(json3);

// Or use the quick util fn
const sketch1_alt = generateJSONHashifySketch(json1, { numHashFunctions: 128 });


console.log('Sketch 1:', sketch1);

// How similar are they? (0.0 to 1.0)
const similarity12 = hasher.compareSketches(sketch1, sketch2);
console.log('Similarity json1 vs json2:', similarity12); // Should be kinda high

const similarity13 = compareJSONHashifySketches(sketch1, sketch3); // Util fn for comparison too
console.log('Similarity json1 vs json3:', similarity13); // Should be pretty low

// You can also get the raw shingle set before GOPH if you're curious
const shingleSet1 = hasher.generateShingleSet(json1);
// console.log('Shingles for json1:', shingleSet1);

// If you're using the cache and processing lots of similar stuff, clear it sometimes:
hasher.clearNodeStringCache();

// The estimateJaccardSimilarity is also exported if you have sketches from elsewhere
// and know they were made with compatible GOPH params.
// const directSim = estimateJaccardSimilarity(sketch1, sketch2);
```

## Algorithm Overview: Embedding JSON for Tree Similarity

JSON-Hashify transforms a JSON object into a compact numerical sketch, enabling fast and effective structural similarity comparisons. Here's a high-level overview of the process:

1.  **Tree Conversion & CSR Representation**: The input JSON is first parsed into an internal tree structure. Each key-value pair and array element becomes a node in this tree. To navigate this tree efficiently, it's converted into a [Compressed Sparse Row (CSR)](https://en.wikipedia.org/wiki/Sparse_matrix#Compressed_sparse_row_(CSR,_CRS_or_Yale_format)) format. CSR is typically used for sparse matrices but is adapted here to represent the tree's adjacency list (parent-child relationships), allowing for quick traversal of nodes and their children.

2.  **Subtree Feature Extraction**: For each node in the JSON tree, the algorithm extracts a "subtree" of a specified depth (`options.subtreeDepth`). This means it considers the node itself and its descendants down to that depth. This captures localized structural information around each node.

3.  **Node String Generation & Shingling**: Each node within these extracted subtrees is then represented as a canonical string. This string typically combines the path from the root of the JSON to the node (e.g., `"$root.level1.item[0].name"`) and its value (if it's a leaf node, e.g., `"$root.name:Alice"`). If `preserveArrayOrder` is false, array indices are omitted from the path to treat arrays as bags of elements. These canonical node strings are then broken down into smaller, overlapping k-character pieces called "k-shingles" (where k is `options.shingleSize`). Each shingle is hashed to a numerical representation. This is the knob to turn for weighing the similarity of the content of the objects.

4.  **Frequency Thresholding**: The collection of all hashed shingles from all subtrees forms a multiset (shingles can appear multiple times). Shingles that appear fewer times than `options.frequencyThreshold` are discarded. This step helps to filter out overly rare or noisy features, focusing the signature on more prevalent structural and content patterns.

5.  **Grouped-OPH Sketching**: The resulting set of unique, thresholded shingle hashes is then processed by the Grouped One Permutation Hashing (Grouped-OPH) algorithm. [GOPH](https://www.npmjs.com/package/grouped-oph) is a variation of MinHash designed for efficiency and accuracy. It applies multiple hash functions (controlled by `options.numHashFunctions` and `options.numGroups`) to the shingle set to produce a fixed-size numerical array – the "sketch" or "signature" of the JSON.

6.  **Similarity Estimation**: To compare two JSON objects, their sketches are compared using the Jaccard index. The Jaccard index of the sketches provides a highly efficient and accurate estimate of the Jaccard similarity between the original sets of shingled features. This final similarity score (from 0.0 to 1.0) reflects how structurally and semantically similar the two JSON objects are, based on the extracted and hashed features.

The `enableNodeStringCache` option can further optimize this by caching the shingle sets generated for identical node strings (`path:value` combinations), speeding up processing if many identical sub-structures appear across multiple JSONs or within the same JSON.

## API

### `new JSONHashify(options?)`

Creates a new `JSONHashify` instance.

*   `options` (Object, optional):
    *   `shingleSize` (Number, default: `5`): Size of k-shingles.
    *   `subtreeDepth` (Number, default: `2`): Depth for subtree extraction.
    *   `frequencyThreshold` (Number, default: `1`): Minimum shingle frequency.
    *   `numHashFunctions` (Number, default: `128`): Total hashes in the sketch (must be divisible by `numGroups`).
    *   `numGroups` (Number, default: `4`): Number of groups for GOPH.
    *   `preserveArrayOrder` (Boolean, default: `true`): Distinguish array elements by index.
    *   `ignoreKeys` (Array<String>, default: `[]`): Keys to ignore.
    *   `enableNodeStringCache` (Boolean, default: `false`): Enable an LRU cache for node string shingle sets. Useful if processing many identical sub-structures or the same JSON repeatedly.
    *   `nodeStringCacheSize` (Number, default: `1000`): Max size of the node string cache if enabled.

### `hasher.generateSketch(json)`

Generates a GOPH sketch (an array of numbers) for the input `json`.

### `hasher.generateShingleSet(json)`

Generates the set of unique shingle hashes (integers) for the input `json` after frequency thresholding but *before* GOPH.

### `hasher.compareSketches(sketch1, sketch2, estimationOptions?)`

Estimates Jaccard similarity (0 to 1) between two sketches.

*   `sketch1` (Array<number>): First MinHash sketch.
*   `sketch2` (Array<number>): Second MinHash sketch.
*   `estimationOptions` (Object, optional): Options for Jaccard similarity estimation, passed to the underlying `grouped-oph` library.
    *   `similarityThreshold` (number): The Jaccard similarity threshold (0 to 1) for early termination. If the algorithm can confidently determine that the true similarity is above or below this threshold with an error probability less than `errorTolerance`, it may return an approximate result early (typically `0.0` or `1.0`).
    *   `errorTolerance` (number): The acceptable probability (0 to 1, e.g., 0.01 for 1%) of making an incorrect early termination decision when `similarityThreshold` is used.
    *   Note: `numGroups` (from the hasher instance) is automatically provided to the estimation function when these options are used.

### `hasher.clearNodeStringCache()`

Clears the internal node string shingle cache if it was enabled.

### `generateJSONHashifySketch(json, options?)`

Utility function. Creates a temporary `JSONHashify` instance with `options` and returns `hasher.generateSketch(json)`.

### `compareJSONHashifySketches(sketch1, sketch2, constructorOptions?, estimationOptions?)`

Utility function. Creates a temporary `JSONHashify` instance with `constructorOptions` and returns `hasher.compareSketches(sketch1, sketch2, estimationOptions)`.

### `estimateJaccardSimilarity(sketch1, sketch2, options?)`

Directly estimates Jaccard similarity from two sketches. Assumes sketches are compatible. This is re-exported from `grouped-oph`.
See [`grouped-oph`](https://www.npmjs.com/package/grouped-oph) documentation for details on its `options` for approximation.

## Performance

Benchmarks are run with `node bench/random-json.js`. 

### Sketch Generation Performance

"Stateful" uses `enableNodeStringCache: true` and it will memoize recurring subtrees to speed up your hashing. "Stateless" creates a new hasher or uses one with the cache disabled/cleared for each operation on *different* random JSONs.

| Benchmark Configuration         | Mode      | HPS (Higher is Better) | Per Call Duration |
|---------------------------------|-----------|------------------------|-------------------|
| JSON (Depth 2, Max Children 3)  | Stateless | 30790.41               | ~32.5 μs          |
| JSON (Depth 2, Max Children 3)  | Stateful  | 35432.14               | ~28.2 μs          |
| JSON (Depth 3, Max Children 5)  | Stateless | 4862.18                | ~206 μs           |
| JSON (Depth 3, Max Children 5)  | Stateful  | 2895.05                | ~345 μs           |
| JSON (Depth 4, Max Children 5)  | Stateless | 1579.90                | ~633 μs           |
| JSON (Depth 4, Max Children 5)  | Stateful  | 1480.12                | ~676 μs           |
| JSON (Depth 3, Max Children 8)  | Stateless | 1647.91                | ~607 μs           |
| JSON (Depth 3, Max Children 8)  | Stateful  | 1055.50                | ~947 μs           |
| JSON (Depth 5, Max Children 3)  | Stateless | 3107.03                | ~322 μs           |
| JSON (Depth 5, Max Children 3)  | Stateful  | 3353.01                | ~298 μs           |

**Note on Sketch Generation Cache:** The `enableNodeStringCache` option is beneficial when processing the exact same JSON multiple times or when JSON objects share many identical sub-structures (leading to identical `path:value` strings for nodes). For highly diverse JSON inputs without repeated sub-structures, the overhead of cache management might slightly reduce performance compared to stateless generation.


## Why?

There's a lot of cases where you want a vector to roughly compare two objects. For instance, in deduplication, or in the clustering of structural features. If you wanted to find code duplication, then you could calculate the AST of the codebase, then recursively JSONHashify the resulting AST and quickly find duplication much faster than any deterministic approach. Similarly, if you were to encode the neighborhood tree of a node in a graph, you could find similar structures much more rapidly than if you used any graph analysis algorithms. Due to the nature of the shingling this is content sensitive as well. Structures with keys in common will cluster closer than identical structures without keys in common. This makes it ideal for a lot of common "Similarity" use cases.


## Install

```bash
npm install json-hashify
```


## License

MIT. 2023