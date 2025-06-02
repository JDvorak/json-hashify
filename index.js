import { generateGroupedOPHSignature, estimateJaccardSimilarity, murmurhash3_32_gc_single_int } from 'grouped-oph';
import { HyperbolicLRUCache } from 'hyperbolic-lru';

// Define rolling hash constants at a higher scope or make them configurable
const ROLLING_PRIME_BASE = 257;
const ROLLING_PRIME_MODULUS = 1000000007;

/**
 * Implements the JSONHash algorithm based on TreeHash principles.
 * Converts JSON to a tree, uses CSR for subtree extraction,
 * Uses Grouped One Permutation Hashing (GOPH) on the set of k-shingles 
 * derived from the path:value representation of nodes within the extracted subtrees
 * (filtered by frequency threshold).
 */
class JSONHashify {
    /**
     * Initializes JSONHashify with optional configuration.
     * @param {object} [options={}] Configuration options.
     * @param {number} [options.subtreeDepth=2] The depth of subtrees to consider for shingling.
     * @param {number} [options.frequencyThreshold=1] The minimum frequency for a shingle to be included in the final sketch.
     * @param {number} [options.numHashFunctions=128] Number of hash values in the final signature (total sketch length). Replaces `numPermutations`.
     * @param {number} [options.numGroups=4] Number of groups for GOPH (g=4 recommended).
     * @param {boolean} [options.preserveArrayOrder=true] Whether to treat array elements distinctly based on index for structure.
     * @param {number} [options.shingleSize=5] The size of k-shingles for node string (path:value) hashing.
     * @param {Array<string>} [options.ignoreKeys=[]] Keys to ignore during tree traversal and hashing (e.g., ['position']).
     * @param {number} [options.stringToHashifyThreshold=128] String length above which to use JsonRollingHasher for the value.
     * @param {number} [options.arrayToHashifyThreshold=10] Array length above which to use JsonRollingHasher for the value.
     * @param {boolean} [options.enableNodeStringCache=false] Whether to cache shingle sets for identical node strings (path:value) across calls within the same JSONHashify instance.
     * @param {number} [options.nodeStringCacheSize=1000] Max number of items in the node string shingle cache if enabled.
     */
    constructor(options = {}) {
        this.numHashFunctions = options.numHashFunctions ?? options.numPermutations ?? 128;
        this.numGroups = options.numGroups ?? 4;

        this.options = {
            subtreeDepth: options.subtreeDepth ?? 2,
            frequencyThreshold: options.frequencyThreshold ?? 1,
            preserveArrayOrder: options.preserveArrayOrder ?? true,
            shingleSize: options.shingleSize ?? 5,
            numHashFunctions: this.numHashFunctions,
            enableNodeStringCache: options.enableNodeStringCache ?? false,
            nodeStringCacheSize: options.nodeStringCacheSize ?? 1000
        };

        this.ignoreKeys = new Set(options.ignoreKeys || []);
        this._useSetForShingles = this.options.frequencyThreshold === 1;

        if (this.options.enableNodeStringCache) {
            this.nodeStringShingleCache = new HyperbolicLRUCache(this.options.nodeStringCacheSize);
        }

        if (this.options.shingleSize < 1) {
            throw new Error('shingleSize must be at least 1');
        }
        if (this.numHashFunctions <= 0 || !Number.isInteger(this.numHashFunctions)) {
             throw new Error('numHashFunctions must be a positive integer.');
        }
         if (this.numGroups <= 0 || !Number.isInteger(this.numGroups)) {
             throw new Error('numGroups must be a positive integer.');
        }
        if (this.numHashFunctions % this.numGroups !== 0) {
            throw new Error('numHashFunctions must be divisible by numGroups');
        }

        // Pre-calculate rolling hash power: ROLLING_PRIME_BASE^(shingleSize-1) % ROLLING_PRIME_MODULUS
        this._rollingHashPower = 1;
        const k = this.options.shingleSize;
        if (k > 1) { // Only needed if k > 1, for k=1, power is 1 (BASE^0)
            for (let i = 0; i < k - 1; i++) {
                this._rollingHashPower = (this._rollingHashPower * ROLLING_PRIME_BASE) % ROLLING_PRIME_MODULUS;
            }
        }
    }



    /**
     * Parses JSON and directly builds the CSR representation in a single pass.
     * @param {object|Array} json The input JSON object or array.
     * @returns {{rowPtr: Array<number>, colIndices: Array<number>, nodeMap: Map<number, object>}} CSR representation.
     */
    _buildCSRFromJSON(json) {
        const nodeMap = new Map(); 
        const childLists = [];    
        var nodeIdCounter = 0;

        if (typeof json !== 'object' || json === null) {
            const nodeId = nodeIdCounter++;
            const nodeData = { id: nodeId, path: '$root', value: json };
            nodeMap.set(nodeId, nodeData);
            childLists[nodeId] = []; 
            const rowPtr = [0, 0];
            const colIndices = [];
            return { rowPtr, colIndices, nodeMap };
        }

        const rootId = nodeIdCounter++;
        const rootNodeData = { id: rootId, path: '$root' };
        nodeMap.set(rootId, rootNodeData);
        childLists[rootId] = []; 

        const stack = [{ obj: json, path: '$root', parentId: rootId }];

        while (stack.length > 0) {
            const { obj, path, parentId } = stack.pop();

            const processNode = (item, itemKey, currentPath, parentId) => {
                const elementPath = currentPath === '$root' ? itemKey : `${currentPath}.${itemKey}`;
                const isLeaf = typeof item !== 'object' || item === null;

                const childId = nodeIdCounter++;
                const nodeData = { id: childId, path: elementPath, value: isLeaf ? item : undefined };
                nodeMap.set(childId, nodeData);
                childLists[childId] = []; 
                childLists[parentId].push(childId); 

                if (!isLeaf) {
                    stack.push({ obj: item, path: elementPath, parentId: childId });
                }
            };

            if (Array.isArray(obj)) {
                const len = obj.length;
                for (var i = 0; i < len; i++) {
                    const elementPathKey = this.options.preserveArrayOrder ? `[${i}]` : ''; 
                    const fullPath = this.options.preserveArrayOrder ? `${path}[${i}]` : path;
                    processNode(obj[i], elementPathKey, path, parentId);
                }
            } else { 
                const keys = Object.keys(obj);
                const len = keys.length;
                for (var i = 0; i < len; i++) {
                    const key = keys[i];
                    if (this.ignoreKeys.has(key)) continue;
                    processNode(obj[key], key, path, parentId);
                }
            }
        }
 
        const numNodes = nodeIdCounter;
        const rowPtr = new Array(numNodes + 1);
        rowPtr[0] = 0;
        var totalChildren = 0;

        for (var i = 0; i < numNodes; i++) {
            const children = childLists[i] || []; 
            rowPtr[i + 1] = rowPtr[i] + children.length;
            totalChildren += children.length; 
        }

        const colIndices = new Array(totalChildren); 
        var currentColIndex = 0;
        for (var i = 0; i < numNodes; i++) {
            const children = childLists[i] || [];
            for (var j = 0; j < children.length; j++) {
                colIndices[currentColIndex++] = children[j];
            }
        }

        return { rowPtr, colIndices, nodeMap };
    }

    /**
     * Extracts all nodes within a subtree from the CSR data.
     * @param {object} csrData CSR data from _convertToCSR.
     * @param {number} startNodeId The ID of the root node of the subtree.
     * @returns {Array<number>} List of node IDs in the subtree.
     */
    _extractSubtrees(csrData, startNodeId) {
        const { rowPtr, colIndices, nodeMap } = csrData;
        const maxDepth = this.options.subtreeDepth;
        const subtreeNodeIds = [];
        const visited = new Set(); 
        const queue = []; 

        if (!nodeMap.has(startNodeId) || startNodeId >= rowPtr.length - 1) {
            return []; 
        }

        queue.push([startNodeId, 0]);
        visited.add(startNodeId);

        while (queue.length > 0) {
            const [currentNodeId, currentDepth] = queue.shift();
            subtreeNodeIds.push(currentNodeId);

            if (currentDepth < maxDepth) {
                const childrenStart = rowPtr[currentNodeId];
                const childrenEnd = rowPtr[currentNodeId + 1];

                for (var i = childrenStart; i < childrenEnd; i++) {
                    const childId = colIndices[i];
                    if (childId !== -1 && nodeMap.has(childId) && !visited.has(childId)) {
                        visited.add(childId);
                        queue.push([childId, currentDepth + 1]);
                    }
                }
            }
        }
        return subtreeNodeIds; 
    }

    /**
     * Generates hashed k-shingles for a single node and updates their frequencies in the provided multiset.
     * @param {object} node The node object (from nodeMap).
     * @param {Map<number, number>|Set<number>} shingleCollection The collection (Map or Set) to update.
     */
    _updateShingleFrequenciesForNode(node, shingleCollection) {
        const k = this.options.shingleSize;
        if (!node) return;

        if (this.options.enableNodeStringCache) {
            // --- CACHING PATH ---
            var nodePathString = node.path;
            const value = node.value;
            let shingleInputString = nodePathString;
            if (value !== undefined) {
                let valueStringForCacheKey;
                const type = typeof value;
                if (type === 'string') valueStringForCacheKey = value;
                else if (type === 'number' || type === 'boolean') valueStringForCacheKey = String(value);
                else valueStringForCacheKey = JSON.stringify(value);
                shingleInputString += ':' + valueStringForCacheKey;
            }

            if (this.nodeStringShingleCache.has(shingleInputString)) {
                const cachedShingles = this.nodeStringShingleCache.get(shingleInputString);
                for (const shingleHash of cachedShingles) {
                    if (this._useSetForShingles) {
                        shingleCollection.add(shingleHash);
                    } else {
                        shingleCollection.set(shingleHash, (shingleCollection.get(shingleHash) || 0) + 1);
                    }
                }
                return; 
            }

            const shinglesGeneratedForThisNode = new Set();
            const targetStringToShingle = shingleInputString; 
            
            const primeBase = ROLLING_PRIME_BASE;
            const primeModulus = ROLLING_PRIME_MODULUS;
            const power = this._rollingHashPower;

            if (targetStringToShingle.length >= k) {
                let currentHash = 0;
                for (let j = 0; j < k; j++) {
                    currentHash = (currentHash * primeBase + targetStringToShingle.charCodeAt(j)) % primeModulus;
                }
                shinglesGeneratedForThisNode.add(murmurhash3_32_gc_single_int(currentHash, 0));
                const limit = targetStringToShingle.length - k;
                for (let i = 0; i < limit; i++) {
                    const charOutCode = targetStringToShingle.charCodeAt(i);
                    const charInCode = targetStringToShingle.charCodeAt(i + k);
                    let termToRemove = (charOutCode * power) % primeModulus;
                    currentHash = (currentHash - termToRemove + primeModulus) % primeModulus;
                    currentHash = (currentHash * primeBase) % primeModulus;
                    currentHash = (currentHash + charInCode) % primeModulus;
                    shinglesGeneratedForThisNode.add(murmurhash3_32_gc_single_int(currentHash, 0));
                }
            } else if (targetStringToShingle.length > 0) {
                let polyHash = 0;
                for (let j = 0; j < targetStringToShingle.length; j++) {
                    polyHash = (polyHash * primeBase + targetStringToShingle.charCodeAt(j)) % primeModulus;
                }
                shinglesGeneratedForThisNode.add(murmurhash3_32_gc_single_int(polyHash, 0));
            }

            this.nodeStringShingleCache.set(shingleInputString, shinglesGeneratedForThisNode);

            for (const shingleHash of shinglesGeneratedForThisNode) {
                if (this._useSetForShingles) {
                    shingleCollection.add(shingleHash);
                } else {
                    shingleCollection.set(shingleHash, (shingleCollection.get(shingleHash) || 0) + 1);
                }
            }

        } else {
            // --- ORIGINAL STATELESS PATH (minimal changes from before caching) ---
            var nodeString = node.path; 
            const value = node.value;
            if (value !== undefined) {
                var valueString; 
                const type = typeof value;
                if (type === 'string') valueString = value;
                else if (type === 'number' || type === 'boolean') valueString = String(value);
                else valueString = JSON.stringify(value);
                nodeString += ':' + valueString;
            }

            const primeBase = ROLLING_PRIME_BASE;
            const primeModulus = ROLLING_PRIME_MODULUS;
            const power = this._rollingHashPower;
            const targetString = nodeString; 

            if (targetString.length >= k) {
                let currentHash = 0;
                for (let j = 0; j < k; j++) {
                    currentHash = (currentHash * primeBase + targetString.charCodeAt(j)) % primeModulus;
                }
                const finalInitialHash = murmurhash3_32_gc_single_int(currentHash, 0);
                if (this._useSetForShingles) {
                    shingleCollection.add(finalInitialHash);
                } else {
                    shingleCollection.set(finalInitialHash, (shingleCollection.get(finalInitialHash) || 0) + 1);
                }

                const limit = targetString.length - k;
                for (let i = 0; i < limit; i++) {
                    const charOutCode = targetString.charCodeAt(i);
                    const charInCode = targetString.charCodeAt(i + k);
                    let termToRemove = (charOutCode * power) % primeModulus;
                    currentHash = (currentHash - termToRemove + primeModulus) % primeModulus;
                    currentHash = (currentHash * primeBase) % primeModulus;
                    currentHash = (currentHash + charInCode) % primeModulus;
                    
                    const finalRolledHash = murmurhash3_32_gc_single_int(currentHash, 0);
                    if (this._useSetForShingles) {
                        shingleCollection.add(finalRolledHash);
                    } else {
                        shingleCollection.set(finalRolledHash, (shingleCollection.get(finalRolledHash) || 0) + 1);
                    }
                }
            } else if (targetString.length > 0) {
                let polyHash = 0;
                for (let j = 0; j < targetString.length; j++) {
                    polyHash = (polyHash * primeBase + targetString.charCodeAt(j)) % primeModulus;
                }
                const hashValue = murmurhash3_32_gc_single_int(polyHash, 0);
                if (this._useSetForShingles) {
                    shingleCollection.add(hashValue);
                } else {
                    shingleCollection.set(hashValue, (shingleCollection.get(hashValue) || 0) + 1);
                }
            }
        }
    }

    /**
     * Builds the multiset of shingle hashes from the JSON input.
     * @private
     * @param {object|Array} json The input JSON object or array.
     * @returns {Map<number, number>|Set<number>} A collection of shingle hashes (Map: hash -> count, or Set: hash).
     */
    _buildShingleMultiset(json) {
        const csrData = this._buildCSRFromJSON(json);
        let allShinglesCollection; 
        if (this._useSetForShingles) {
            allShinglesCollection = new Set(); 
        } else {
            allShinglesCollection = new Map(); 
        }

        for (const startNodeId of csrData.nodeMap.keys()) {
            if (startNodeId >= 0 && startNodeId < (csrData.rowPtr.length - 1)) {
                const subtreeNodeIds = this._extractSubtrees(csrData, startNodeId);
                for (const nodeId of subtreeNodeIds) {
                    const subtreeNode = csrData.nodeMap.get(nodeId);
                    this._updateShingleFrequenciesForNode(subtreeNode, allShinglesCollection);
                }
            }
        }
        return allShinglesCollection;
    }

    /**
     * Generates the final set of shingle hashes for a given JSON object after frequency thresholding.
     * @param {object|Array} json The input JSON object or array.
     * @returns {Set<number>} The final set of shingle hashes.
     */
    generateShingleSet(json) {
        const allShinglesCollection = this._buildShingleMultiset(json);
        const finalShingleHashSet = this._thresholdMultiset(allShinglesCollection);
        return finalShingleHashSet;
    }

    /**
     * Generates the MinHash sketch for a given JSON object.
     * @param {object|Array} json The input JSON object or array.
     * @returns {Array<number>} The MinHash sketch (signature).
     */
    generateSketch(json) {
        const allShinglesCollection = this._buildShingleMultiset(json);
        const finalShingleHashSet = this._thresholdMultiset(allShinglesCollection);

        const signature = generateGroupedOPHSignature(
            Array.from(finalShingleHashSet), 
            this.numHashFunctions, 
            this.numGroups
        );
        
        return signature;
    }

    /**
     * Compares two MinHash sketches and estimates Jaccard similarity.
     * @param {Array<number>} sketch1 First MinHash sketch.
     * @param {Array<number>} sketch2 Second MinHash sketch.
     * @param {object} [estimationOptions={}] Options for Jaccard similarity estimation.
     * @param {number} [estimationOptions.similarityThreshold] The Jaccard similarity threshold (0 to 1) for early termination.
     *                                                       If the algorithm can confidently determine that the true similarity is
     *                                                       above or below this threshold with an error probability less than
     *                                                       `estimationOptions.errorTolerance`, it may return an approximate result early.
     * @param {number} [estimationOptions.errorTolerance] The acceptable probability (0 to 1, e.g., 0.01 for 1%)
     *                                                    of making an incorrect early termination decision.
     * @returns {number} Estimated Jaccard similarity (0 to 1).
     *                   If `similarityThreshold` and `errorTolerance` are provided,
     *                   the function may return `1.0` if it determines the sets are likely similar enough
     *                   or `0.0` if likely dissimilar enough, without computing the exact Jaccard index.
     */
    compareSketches(sketch1, sketch2, estimationOptions = {}) {
        const { similarityThreshold, errorTolerance, ...otherOptions } = estimationOptions;
        let finalEstimationOptions = { ...otherOptions }; // Pass through any other options

        if (similarityThreshold !== undefined && errorTolerance !== undefined) {
            finalEstimationOptions.similarityThreshold = similarityThreshold;
            finalEstimationOptions.errorTolerance = errorTolerance;
            finalEstimationOptions.numGroups = this.numGroups; // Add numGroups from the instance
        }
        return estimateJaccardSimilarity(sketch1, sketch2, finalEstimationOptions);
    }

    /**
     * Filters the multiset of shingle hashes based on the frequency threshold.
     * @private
     * @param {Map<number, number>|Set<number>} shingleCollection Map of hash -> count or Set of hashes.
     * @returns {Set<number>} Set of hashes meeting the threshold.
     */
    _thresholdMultiset(shingleCollection) {
        const thresholdedSet = new Set();
        const threshold = this.options.frequencyThreshold;

        if (this._useSetForShingles) {
            // If _useSetForShingles is true, frequencyThreshold is 1.
            // All elements in the Set automatically meet this threshold.
            for (const hash of shingleCollection) { 
                thresholdedSet.add(hash);
            }
        } else { 
            for (const [hash, count] of shingleCollection.entries()) { 
                if (count >= threshold) {
                    thresholdedSet.add(hash);
                }
            }
        }
        return thresholdedSet;
    }

    /**
     * Clears the node string shingle cache if it's enabled and has been populated.
     */
    clearNodeStringCache() {
        if (this.options.enableNodeStringCache && this.nodeStringShingleCache) {
            this.nodeStringShingleCache.clear();
        }
    }
}

/**
 * Utility function to create a JSONHashify instance and generate a sketch.
 * @param {object|Array} json Input JSON.
 * @param {object} [options] Options for JSONHashify constructor.
 * @returns {Array<number>} The MinHash sketch.
 */
function generateJSONHashifySketch(json, options) {
    const hasher = new JSONHashify(options);
    return hasher.generateSketch(json);
}

/**
 * Utility function to create a JSONHashify instance and compare sketches.
 * @param {Array<number>} sketch1 First sketch.
 * @param {Array<number>} sketch2 Second sketch.
 * @param {object} [constructorOptions={}] Options for JSONHashify constructor.
 * @param {object} [estimationOptions={}] Options for Jaccard similarity estimation (see `JSONHashify.prototype.compareSketches`).
 * @returns {number} Estimated Jaccard similarity.
 */
function compareJSONHashifySketches(sketch1, sketch2, constructorOptions = {}, estimationOptions = {}) {
    const comparer = new JSONHashify(constructorOptions);
    return comparer.compareSketches(sketch1, sketch2, estimationOptions);
}


export {
    JSONHashify,
    generateJSONHashifySketch,
    compareJSONHashifySketches,
    estimateJaccardSimilarity
};
