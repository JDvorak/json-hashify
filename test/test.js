import tape from 'tape';
import _test from 'tape-filter';
import { JSONHash, estimateJaccardSimilarity } from '../index.js'; // Assuming index.js exports these

const test = _test(tape);

// --- Helper Functions ---

/**
 * Counts set bits (1s) in a BigInt.
 * @param {BigInt} n Non-negative BigInt.
 * @returns {number}
 */
function popcount(n) {
    let count = 0;
    while (n > 0n) {
        count += Number(n & 1n);
        n >>= 1n;
    }
    return count;
}

/**
 * Calculates Hamming distance between two BigInts.
 * @param {BigInt} bigint1
 * @param {BigInt} bigint2
 * @returns {number}
 */
function hammingDistance(bigint1, bigint2) {
    return popcount(bigint1 ^ bigint2);
}

/**
 * Helper function to pack an array of bits (0s/1s) into a BigInt.
 * Assumes bits[0] is the least significant bit.
 * @param {Array<number>} bits - Array of 0s or 1s.
 * @returns {BigInt}
 */
function _bitsToBigInt(bits) {
    let result = 0n;
    for (let i = bits.length - 1; i >= 0; i--) {
        result = (result << 1n) | (bits[i] ? 1n : 0n);
    }
    return result;
}

/**
 * Calculates quantile boundaries for each column (position) in an array of signatures.
 * @param {Array<Array<number>>} signatures - Array of GOPH signatures.
 * @param {number} numBuckets - The desired number of buckets (e.g., 16 for 4 bits).
 * @returns {Array<Array<number>>} Array where each element is an array of `numBuckets - 1` boundaries for that position.
 */
function calculateQuantileBoundaries(signatures, numBuckets) {
    if (!signatures || signatures.length === 0 || numBuckets < 2) {
        return [];
    }
    const numPositions = signatures[0].length;
    const numSignatures = signatures.length;
    const allBoundaries = new Array(numPositions);

    for (let j = 0; j < numPositions; j++) {
        const values = new Array(numSignatures);
        for (let i = 0; i < numSignatures; i++) {
            values[i] = signatures[i][j];
        }
        values.sort((a, b) => a - b); // Sort numerically

        const boundaries = new Array(numBuckets - 1);
        for (let k = 1; k < numBuckets; k++) {
            const percentileIndex = Math.floor(numSignatures * k / numBuckets);
            // Handle edge cases and potential duplicates
            const index = Math.min(numSignatures - 1, percentileIndex); 
            // Simple approach: take the value at the percentile index.
            // More robust might involve averaging if index falls between values.
            boundaries[k - 1] = values[index]; 
        }
        // Ensure boundaries are distinct and sorted (duplicates can collapse buckets)
        const uniqueSortedBoundaries = [...new Set(boundaries)].sort((a, b) => a - b);
        // If fewer boundaries than needed due to duplicates, we might need a strategy
        // like adding small epsilon or just accepting fewer effective buckets.
        // For now, we use the unique sorted ones.
        allBoundaries[j] = uniqueSortedBoundaries; 
    }
    return allBoundaries;
}

/**
 * Generates a map from integer index (0 to 2^bits - 1) to its Gray code value.
 * @param {number} bits - The number of bits (e.g., 2, 4, 8).
 * @returns {Array<BigInt>} An array where index `i` holds the BigInt Gray code for `i`.
 */
function generateGrayCodeMap(bits) {
    const size = 1 << bits;
    const map = new Array(size);
    for (let i = 0; i < size; i++) {
        // Standard binary to Gray code conversion: i XOR (i >> 1)
        map[i] = BigInt(i ^ (i >> 1));
    }
    return map;
}

/**
 * Simple JSON object generator for testing.
 */
function generateSampleJson(depth = 2, breadth = 3) {
    if (depth <= 0) {
        return Math.random() < 0.5 ? Math.random() * 100 : `val_${Math.random().toString(36).substring(7)}`;
    }
    const obj = {};
    for (let i = 0; i < breadth; i++) {
        obj[`key_${depth}_${i}`] = generateSampleJson(depth - 1, breadth);
    }
    // Add some array variation
     if (Math.random() < 0.3) {
         obj[`arr_${depth}`] = Array.from({length: breadth}, () => generateSampleJson(depth -1, breadth));
     }
    return obj;
}

/**
 * Creates a slightly modified version of a JSON object.
 */
function modifyJsonSlightly(json) {
    const stringified = JSON.stringify(json);
    const parsed = JSON.parse(stringified); // Deep copy

    // Find a random leaf node to change
    let keys = Object.keys(parsed);
    let target = parsed;
    while (keys.length > 0) {
        const key = keys[Math.floor(Math.random() * keys.length)];
         if (typeof target[key] === 'object' && target[key] !== null && Object.keys(target[key]).length > 0) {
             target = target[key];
             keys = Object.keys(target);
         } else {
             // Found a leaf or near-leaf
             target[key] = `modified_${Math.random().toString(36).substring(7)}`;
             break;
         }
    }
     // If no leaf was found (e.g., empty object), add a key
     if (Object.keys(parsed).length === 0 || keys.length === 0) {
        parsed['new_key'] = 'new_value';
     }

    return parsed;
}

/**
 * Generates JSON with varying depth/breadth for more realistic distribution.
 */
function generateVaryingJson() {
    const depth = Math.floor(Math.random() * 4) + 1; // 1 to 4
    const breadth = Math.floor(Math.random() * 5) + 2; // 2 to 6
    return generateSampleJson(depth, breadth);
}

/**
 * Calculates median thresholds for each column (position) in an array of signatures.
 * @param {Array<Array<number>>} signatures - Array of GOPH signatures.
 * @returns {Array<number>} Array where each element is the median value for that position.
 */
function calculateMedianThresholds(signatures) {
    if (!signatures || signatures.length === 0) {
        return [];
    }
    const numPositions = signatures[0].length;
    const numSignatures = signatures.length;
    const medians = new Array(numPositions);

    for (let j = 0; j < numPositions; j++) {
        const values = new Array(numSignatures);
        for (let i = 0; i < numSignatures; i++) {
            values[i] = signatures[i][j];
        }
        values.sort((a, b) => a - b); // Sort numerically

        const mid = Math.floor(numSignatures / 2);
        if (numSignatures % 2 === 0) {
            // Average of the two middle elements for even size
            medians[j] = (values[mid - 1] + values[mid]) / 2;
        } else {
            // Middle element for odd size
            medians[j] = values[mid];
        }
    }
    return medians;
}

/**
 * Estimates cardinalities (distinct counts) for each column/index in signatures.
 * Uses actual distinct count from the sample as a proxy for a sketch.
 * @param {Array<Array<number>>} signatures - Array of GOPH signatures.
 * @returns {Array<number>} Array where index `j` holds the distinct count for column `j`.
 */
function estimateCardinalities(signatures) {
    if (!signatures || signatures.length === 0) {
        return [];
    }
    const numPositions = signatures[0].length;
    const numSignatures = signatures.length;
    const distinctCounts = new Array(numPositions);

    for (let j = 0; j < numPositions; j++) {
        const values = new Set();
        for (let i = 0; i < numSignatures; i++) {
            values.add(signatures[i][j]);
        }
        distinctCounts[j] = values.size;
    }
    return distinctCounts;
}

/**
 * Calculates the Shannon entropy for a list of values.
 * @param {Array<number>} values - Array of values for one position/index.
 * @returns {number} The calculated entropy in bits. Returns 0 if input is empty or has only one unique value.
 */
function calculateEntropy(values) {
    if (!values || values.length === 0) {
        return 0;
    }

    const valueCounts = new Map();
    for (const value of values) {
        valueCounts.set(value, (valueCounts.get(value) || 0) + 1);
    }

    if (valueCounts.size <= 1) {
        return 0; // No uncertainty if only one value
    }

    let entropy = 0;
    const totalCount = values.length;
    for (const count of valueCounts.values()) {
        const probability = count / totalCount;
        entropy -= probability * Math.log2(probability);
    }

    // Handle potential NaN if probability is 0 (log2(0) = -Infinity).
    // Although the loop skips count=0, floating point issues might occur.
    return isNaN(entropy) ? 0 : entropy;
}

/**
 * Finds the indices of the k smallest values in a distance array.
 * @param {Array<number>} distances - Array of distances.
 * @param {number} k - The number of smallest distances to find.
 * @returns {Set<number>} A set containing the indices of the top k items.
 */
function getTopKIndices(distances, k) {
    if (k <= 0) return new Set();
    const indexedDistances = distances.map((dist, index) => ({ dist, index }));
    // Sort by distance, ascending
    indexedDistances.sort((a, b) => a.dist - b.dist);
    // Take the indices of the top k
    const topKIndices = new Set();
    const limit = Math.min(k, indexedDistances.length);
    for (let i = 0; i < limit; i++) {
        topKIndices.add(indexedDistances[i].index);
    }
    return topKIndices;
}

/**
 * Calculates Precision@k - the proportion of items in hammingTopK that are also in jaccardTopK.
 * @param {Set<number>} jaccardTopKIndices - Set of indices from Jaccard top K.
 * @param {Set<number>} hammingTopKIndices - Set of indices from Hamming top K.
 * @param {number} k - The value of K.
 * @returns {number} Precision@k value (0 to 1).
 */
function calculatePrecisionAtK(jaccardTopKIndices, hammingTopKIndices, k) {
    if (k <= 0) return 1.0; // Or arguably 0.0, but 1.0 if k=0 implies no retrieval needed
    let intersectionSize = 0;
    for (const index of hammingTopKIndices) {
        if (jaccardTopKIndices.has(index)) {
            intersectionSize++;
        }
    }
    // Handle cases where hammingTopKIndices might have size < k if dataset is small
    const denominator = Math.min(k, hammingTopKIndices.size);
    return denominator === 0 ? 1.0 : intersectionSize / denominator;
    // Alternative: divide by k always? Let's stick with denominator = min(k, actual_retrieved_count)
    // return k === 0 ? 1.0 : intersectionSize / k;
}

/**
 * Calculates Set Overlap@k (Jaccard Index of Top K sets).
 * Measures the proportion of items that are shared between the two top-k lists,
 * relative to the total number of unique items across both lists.
 * @param {Set<number>} jaccardTopKIndices - Set of indices from Jaccard top K.
 * @param {Set<number>} hammingTopKIndices - Set of indices from Hamming top K.
 * @returns {number} Set Overlap@k value (0 to 1).
 */
function calculateSetOverlapAtK(jaccardTopKIndices, hammingTopKIndices) {
    let intersectionSize = 0;
    for (const index of hammingTopKIndices) {
        if (jaccardTopKIndices.has(index)) {
            intersectionSize++;
        }
    }
    const unionSize = jaccardTopKIndices.size + hammingTopKIndices.size - intersectionSize;
    return unionSize === 0 ? 1.0 : intersectionSize / unionSize;
}

// // --- Test 4: Learned 4-bit Quantile --- (Precision@10)
// // Renumbering tests to start from 1
// // --- Test 1: Learned 4-bit Quantile --- (Precision@1/10 + Overlap@10)
// test('JSONHash Ordinal Accuracy (Learned 4-bit Quantile)', (t) => {
//     const numHashFunctions = 128;
//     const numBitsPerElement = 4;
//     const numBuckets = 1 << numBitsPerElement; // 16 buckets
//     const finalBinaryLength = numHashFunctions * numBitsPerElement; // 512 bits
//     const k10 = 10; // Evaluate @10
//     const k1 = 1; // Evaluate @1
//     const datasetSize = 50;
//     const sampleSize = 100; // For learning boundaries
//     const numTrials = 100; // Reduced trials

//     const jsonHashOptions = { numHashFunctions };
//     const hasher = new JSONHash(jsonHashOptions);

//     // --- 1. Calculate Quantile Boundaries (for 16 buckets) --- 
//     t.comment(`Calculating ${numBuckets}-quantile boundaries from ${sampleSize} varying JSONs...`);
//     const sampleSignatures = [];
//     for (let i = 0; i < sampleSize; i++) {
//         sampleSignatures.push(hasher.generateSketch(generateVaryingJson()));
//     }
//     const quantileBoundaries = calculateQuantileBoundaries(sampleSignatures, numBuckets);
//     t.comment('Boundary calculation complete.');

//     // --- Binarization Function (4-bit Quantile Index) --- 
//     function binarizeSignatureQuantile4bit(signature, boundariesPerPos) {
//         let finalHash = 0n;
//         for (let j = 0; j < numHashFunctions; j++) {
//             const value = signature[j];
//             const boundaries = boundariesPerPos[j] || [];
//             let bucketIndex = 0;
//             while (bucketIndex < boundaries.length && value > boundaries[bucketIndex]) {
//                 bucketIndex++;
//             }
//             // bucketIndex is now 0 to N (where N = boundaries.length <= numBuckets - 1)
//             // Clamp bucket index to max possible index (numBuckets - 1)
//             bucketIndex = Math.min(bucketIndex, numBuckets - 1); 

//             // Convert bucket index directly to 4 bits and append
//             // Shift the existing hash left by 4 bits and OR in the bucket index
//             finalHash = (finalHash << BigInt(numBitsPerElement)) | BigInt(bucketIndex);
//         }
//         return finalHash;
//     }

//     // --- 2. Run Trials --- 
//     let totalPrecision10 = 0;
//     let totalPrecision1 = 0;
//     let totalOverlap10 = 0;

//     t.comment(`Running ${numTrials} trials (Learned 4-bit Quantile, P@1/10, Overlap@10)...`);
//     for (let i = 0; i < numTrials; i++) {
//         const queryJson = generateVaryingJson();
//         const datasetJson = Array.from({ length: datasetSize }, () => generateVaryingJson());

//         const querySig = hasher.generateSketch(queryJson);
//         const datasetSigs = datasetJson.map(item => hasher.generateSketch(item));

//         // Jaccard distances
//         const jaccardDistances = datasetSigs.map(sig => 1 - estimateJaccardSimilarity(querySig, sig));

//         // Binarize using learned 4-bit quantiles
//         const queryBin = binarizeSignatureQuantile4bit(querySig, quantileBoundaries);
//         const datasetBins = datasetSigs.map(sig => binarizeSignatureQuantile4bit(sig, quantileBoundaries));
//         const hammingDistances = datasetBins.map(bin => hammingDistance(queryBin, bin));

//         // Get Top K indices
//         const jaccardTop10 = getTopKIndices(jaccardDistances, k10);
//         const hammingTop10 = getTopKIndices(hammingDistances, k10);
//         const jaccardTop1 = getTopKIndices(jaccardDistances, k1);
//         const hammingTop1 = getTopKIndices(hammingDistances, k1);

//         // Calculate Metrics
//         totalPrecision10 += calculatePrecisionAtK(jaccardTop10, hammingTop10, k10);
//         totalPrecision1 += calculatePrecisionAtK(jaccardTop1, hammingTop1, k1);
//         totalOverlap10 += calculateSetOverlapAtK(jaccardTop10, hammingTop10);
//     }
//     t.comment('Trials complete (Learned 4-bit Quantile).');

//     // --- 3. Analysis --- 
//     const avgPrecisionAt10 = totalPrecision10 / numTrials;
//     const avgPrecisionAt1 = totalPrecision1 / numTrials;
//     const avgOverlapAt10 = totalOverlap10 / numTrials;

//     t.comment(`Avg Precision@10 (Learned 4-bit Quantile): ${avgPrecisionAt10.toFixed(4)}`);
//     t.comment(`Avg Precision@1 (Learned 4-bit Quantile):  ${avgPrecisionAt1.toFixed(4)}`);
//     t.comment(`Avg Set Overlap@10 (Learned 4-bit Quantile): ${avgOverlapAt10.toFixed(4)}`);

//     // Check if metrics are reasonably high
//     t.ok(avgPrecisionAt10 > 0.5, `Average Precision@10 should be reasonably high (> 0.5)`);
//     t.ok(avgPrecisionAt1 > 0.1, `Average Precision@1 should be reasonably high (> 0.1)`);
//     t.ok(avgOverlapAt10 > 0.4, `Average Set Overlap@10 should be reasonably high (> 0.4)`);

//     t.end();
// });

// // --- Test 5: Learned 2-bit Gray Code Quantile --- (Precision@10)
// // --- Test 2: Learned 2-bit Gray Code Quantile --- (Precision@1/10 + Overlap@10)
// test('JSONHash Ordinal Accuracy (Learned 2-bit Gray Code Quantile)', (t) => {
//     const numHashFunctions = 128;
//     const numBitsPerElement = 2;
//     const numBuckets = 1 << numBitsPerElement; // 4 buckets
//     const finalBinaryLength = numHashFunctions * numBitsPerElement; // 256 bits
//     const k10 = 10; // Evaluate @10
//     const k1 = 1; // Evaluate @1
//     const datasetSize = 50;
//     const sampleSize = 100; // For learning boundaries
//     const numTrials = 100; // Reduced trials

//     const jsonHashOptions = { numHashFunctions };
//     const hasher = new JSONHash(jsonHashOptions);

//     // Gray code mapping for 2 bits (index to code)
//     const grayCodeMap = generateGrayCodeMap(numBitsPerElement);

//     // --- 1. Calculate Quantile Boundaries (for 4 buckets) --- 
//     t.comment(`Calculating ${numBuckets}-quantile boundaries from ${sampleSize} varying JSONs...`);
//     const sampleSignatures = [];
//     for (let i = 0; i < sampleSize; i++) {
//         sampleSignatures.push(hasher.generateSketch(generateVaryingJson()));
//     }
//     const quantileBoundaries = calculateQuantileBoundaries(sampleSignatures, numBuckets);
//     t.comment('Boundary calculation complete.');

//     // --- Binarization Function (2-bit Gray Code Quantile Index) --- 
//     function binarizeSignatureGrayCode2bit(signature, boundariesPerPos) {
//         let finalHash = 0n;
//         for (let j = 0; j < numHashFunctions; j++) {
//             const value = signature[j];
//             const boundaries = boundariesPerPos[j] || [];
//             let bucketIndex = 0;
//             while (bucketIndex < boundaries.length && value > boundaries[bucketIndex]) {
//                 bucketIndex++;
//             }
//             bucketIndex = Math.min(bucketIndex, numBuckets - 1); 

//             // Convert bucket index to Gray code and append
//             const grayCodeValue = grayCodeMap[bucketIndex];
//             finalHash = (finalHash << BigInt(numBitsPerElement)) | grayCodeValue;
//         }
//         return finalHash;
//     }

//     // --- 2. Run Trials --- 
//     let totalPrecision10 = 0;
//     let totalPrecision1 = 0;
//     let totalOverlap10 = 0;

//     t.comment(`Running ${numTrials} trials (Learned 2-bit Gray Code, P@1/10, Overlap@10)...`);
//     for (let i = 0; i < numTrials; i++) {
//         const queryJson = generateVaryingJson();
//         const datasetJson = Array.from({ length: datasetSize }, () => generateVaryingJson());

//         const querySig = hasher.generateSketch(queryJson);
//         const datasetSigs = datasetJson.map(item => hasher.generateSketch(item));

//         // Jaccard distances
//         const jaccardDistances = datasetSigs.map(sig => 1 - estimateJaccardSimilarity(querySig, sig));

//         // Binarize using learned 2-bit Gray Code quantiles
//         const queryBin = binarizeSignatureGrayCode2bit(querySig, quantileBoundaries);
//         const datasetBins = datasetSigs.map(sig => binarizeSignatureGrayCode2bit(sig, quantileBoundaries));
//         const hammingDistances = datasetBins.map(bin => hammingDistance(queryBin, bin));

//         // Get Top K indices
//         const jaccardTop10 = getTopKIndices(jaccardDistances, k10);
//         const hammingTop10 = getTopKIndices(hammingDistances, k10);
//         const jaccardTop1 = getTopKIndices(jaccardDistances, k1);
//         const hammingTop1 = getTopKIndices(hammingDistances, k1);

//         // Calculate Metrics
//         totalPrecision10 += calculatePrecisionAtK(jaccardTop10, hammingTop10, k10);
//         totalPrecision1 += calculatePrecisionAtK(jaccardTop1, hammingTop1, k1);
//         totalOverlap10 += calculateSetOverlapAtK(jaccardTop10, hammingTop10);
//     }
//     t.comment('Trials complete (Learned 2-bit Gray Code).');

//     // --- 3. Analysis --- 
//     const avgPrecisionAt10 = totalPrecision10 / numTrials;
//     const avgPrecisionAt1 = totalPrecision1 / numTrials;
//     const avgOverlapAt10 = totalOverlap10 / numTrials;

//     t.comment(`Avg Precision@10 (Learned 2-bit Gray Code): ${avgPrecisionAt10.toFixed(4)}`);
//     t.comment(`Avg Precision@1 (Learned 2-bit Gray Code):  ${avgPrecisionAt1.toFixed(4)}`);
//     t.comment(`Avg Set Overlap@10 (Learned 2-bit Gray Code): ${avgOverlapAt10.toFixed(4)}`);

//     // Check if metrics are reasonably high
//     t.ok(avgPrecisionAt10 > 0.5, `Average Precision@10 should be reasonably high (> 0.5)`);
//     t.ok(avgPrecisionAt1 > 0.1, `Average Precision@1 should be reasonably high (> 0.1)`);
//     t.ok(avgOverlapAt10 > 0.4, `Average Set Overlap@10 should be reasonably high (> 0.4)`);

//     t.end();
// });

// --- Test 6: Learned 8-bit Gray Code Quantile --- (Precision@10)
// --- Test 3: Learned 8-bit Gray Code Quantile --- (Precision@1/10 + Overlap@10)
test('JSONHash Ordinal Accuracy (Learned 8-bit Gray Code Quantile)', (t) => {
    const numHashFunctions = 128;
    const numBitsPerElement = 8;
    const numBuckets = 1 << numBitsPerElement; // 256 buckets
    const finalBinaryLength = numHashFunctions * numBitsPerElement; // 1024 bits
    const k10 = 10; // Evaluate @10
    const k1 = 1; // Evaluate @1
    const datasetSize = 50;
    const sampleSize = 100; // For learning boundaries
    const numTrials = 100; // Reduced trials

    const jsonHashOptions = { numHashFunctions };
    const hasher = new JSONHash(jsonHashOptions);

    // Generate Gray code map for 8 bits
    const grayCodeMap = generateGrayCodeMap(numBitsPerElement);

    // --- 1. Calculate Quantile Boundaries (for 256 buckets) --- 
    t.comment(`Calculating ${numBuckets}-quantile boundaries from ${sampleSize} varying JSONs...`);
    const sampleSignatures = [];
    for (let i = 0; i < sampleSize; i++) {
        sampleSignatures.push(hasher.generateSketch(generateVaryingJson()));
    }
    // Increase sample size if boundary calculation is too coarse for 256 buckets
    // Alternatively, accept that some buckets might be merged due to data distribution.
    const quantileBoundaries = calculateQuantileBoundaries(sampleSignatures, numBuckets);
    t.comment('Boundary calculation complete.');

    // --- Binarization Function (8-bit Gray Code Quantile Index) --- 
    function binarizeSignatureGrayCode8bit(signature, boundariesPerPos) {
        let finalHash = 0n;
        for (let j = 0; j < numHashFunctions; j++) {
            const value = signature[j];
            const boundaries = boundariesPerPos[j] || [];
            let bucketIndex = 0;
            while (bucketIndex < boundaries.length && value > boundaries[bucketIndex]) {
                bucketIndex++;
            }
            bucketIndex = Math.min(bucketIndex, numBuckets - 1); 

            // Convert bucket index to Gray code and append
            const grayCodeValue = grayCodeMap[bucketIndex];
            finalHash = (finalHash << BigInt(numBitsPerElement)) | grayCodeValue;
        }
        return finalHash;
    }

    // --- 2. Run Trials --- 
    let totalPrecision10 = 0;
    let totalPrecision1 = 0;
    let totalOverlap10 = 0;

    t.comment(`Running ${numTrials} trials (Learned 8-bit Gray Code, P@1/10, Overlap@10)...`);
    for (let i = 0; i < numTrials; i++) {
        const queryJson = generateVaryingJson();
        const datasetJson = Array.from({ length: datasetSize }, () => generateVaryingJson());

        const querySig = hasher.generateSketch(queryJson);
        const datasetSigs = datasetJson.map(item => hasher.generateSketch(item));

        // Jaccard distances
        const jaccardDistances = datasetSigs.map(sig => 1 - estimateJaccardSimilarity(querySig, sig));

        // Binarize using learned 8-bit Gray Code quantiles
        const queryBin = binarizeSignatureGrayCode8bit(querySig, quantileBoundaries);
        const datasetBins = datasetSigs.map(sig => binarizeSignatureGrayCode8bit(sig, quantileBoundaries));
        const hammingDistances = datasetBins.map(bin => hammingDistance(queryBin, bin));

        // Get Top K indices
        const jaccardTop10 = getTopKIndices(jaccardDistances, k10);
        const hammingTop10 = getTopKIndices(hammingDistances, k10);
        const jaccardTop1 = getTopKIndices(jaccardDistances, k1);
        const hammingTop1 = getTopKIndices(hammingDistances, k1);

        // Calculate Metrics
        totalPrecision10 += calculatePrecisionAtK(jaccardTop10, hammingTop10, k10);
        totalPrecision1 += calculatePrecisionAtK(jaccardTop1, hammingTop1, k1);
        totalOverlap10 += calculateSetOverlapAtK(jaccardTop10, hammingTop10);
    }
    t.comment('Trials complete (Learned 8-bit Gray Code).');

    // --- 3. Analysis --- 
    const avgPrecisionAt10 = totalPrecision10 / numTrials;
    const avgPrecisionAt1 = totalPrecision1 / numTrials;
    const avgOverlapAt10 = totalOverlap10 / numTrials;

    t.comment(`Avg Precision@10 (Learned 8-bit Gray Code): ${avgPrecisionAt10.toFixed(4)}`);
    t.comment(`Avg Precision@1 (Learned 8-bit Gray Code):  ${avgPrecisionAt1.toFixed(4)}`);
    t.comment(`Avg Set Overlap@10 (Learned 8-bit Gray Code): ${avgOverlapAt10.toFixed(4)}`);

    // Check if metrics are reasonably high
    t.ok(avgPrecisionAt10 > 0.5, `Average Precision@10 should be reasonably high (> 0.5)`);
    t.ok(avgPrecisionAt1 > 0.1, `Average Precision@1 should be reasonably high (> 0.1)`);
    t.ok(avgOverlapAt10 > 0.4, `Average Set Overlap@10 should be reasonably high (> 0.4)`);

    t.end();
});

// --- Test 4: Variable Learned Gray Code --- (Precision@1/10 + Overlap@10)
test('JSONHash Ordinal Accuracy (Variable Learned Gray Code)', (t) => {
    const numHashFunctions = 128;
    // finalBinaryLength is now variable, calculated below
    const k10 = 10; // Evaluate @10
    const k1 = 1; // Evaluate @1
    const datasetSize = 50;
    const sampleSize = 100; // For learning boundaries & cardinalities
    const numTrials = 100; // Reduced trials

    const jsonHashOptions = { numHashFunctions };
    const hasher = new JSONHash(jsonHashOptions);

    // --- Setup: Calculate Entropy, Allocate Bits, Calculate Boundaries ---
    const targetTotalBits = 1024; // Define the target bit budget
    t.comment('Setup: Generating sample signatures...');
    const sampleSignatures = [];
    for (let i = 0; i < sampleSize; i++) {
        sampleSignatures.push(hasher.generateSketch(generateVaryingJson()));
    }

    t.comment('Setup: Calculating entropy for each position...');
    const entropies = new Array(numHashFunctions);
    for (let j = 0; j < numHashFunctions; j++) {
        const values_j = sampleSignatures.map(sig => sig[j]);
        entropies[j] = calculateEntropy(values_j);
    }

    // Rank indices by entropy (descending)
    const rankedIndices = entropies
        .map((entropy, index) => ({ index, entropy }))
        .sort((a, b) => b.entropy - a.entropy);

    t.comment(`Setup: Allocating ${targetTotalBits} bits based on entropy ranking...`);
    const bitAllocations = new Array(numHashFunctions);
    const availableBitSizes = [ 8, 4, 2, 1]; // From highest to lowest precision
    let remainingBits = targetTotalBits;
    let currentIndexInRank = 0;
    const allocationCounts = { 8: 0, 4: 0, 2: 0, 1: 0 };

    // Greedily assign bits starting from highest entropy indices
    for (const bits of availableBitSizes) {
        // How many indices can we assign this bit size to?
        // Maximize count for this bit size without overspending *too much*
        // ensuring lower entropy indices still get at least the minimum (2 bits)
        const remainingIndices = numHashFunctions - currentIndexInRank;
        if (remainingIndices <= 0) break;

        // Calculate max number of indices we *could* assign this bit size
        // Ensure remaining indices get at least 2 bits
        const maxPossibleForThisSize = Math.max(0, remainingIndices - (availableBitSizes.length - availableBitSizes.indexOf(bits) -1) ); // Rough estimate, needs refinement
        let numToAssign = 0;
        // Try assigning bits greedily, ensuring we don't make it impossible to fill remaining spots with min bits
        while(numToAssign < remainingIndices && 
              (remainingBits - bits >= (remainingIndices - numToAssign - 1) * 2) && // Ensure enough bits left for others (min 2 bits)
              currentIndexInRank + numToAssign < numHashFunctions) // Check bounds
        {
             numToAssign++;
        }
        // Backtrack if we assigned too many greedily and went over budget overall
         while(numToAssign > 0 && (remainingBits - numToAssign * bits < (remainingIndices - numToAssign) * 2)){
              numToAssign--;
         }
         // Final check: ensure we don't exceed remaining bits total
         numToAssign = Math.min(numToAssign, Math.floor(remainingBits / bits));


        // Assign the calculated number of bits to the current highest entropy indices
        for (let i = 0; i < numToAssign && currentIndexInRank < numHashFunctions; i++) {
            const { index } = rankedIndices[currentIndexInRank];
            bitAllocations[index] = bits;
            allocationCounts[bits]++;
            remainingBits -= bits;
            currentIndexInRank++;
        }
    }

    // Distribute remaining bits (if any) by assigning to lowest assigned bits first, or handle deficit
     if (remainingBits > 0) {
         // If bits remain, try upgrading lowest-bit assignments (usually 2-bit)
         t.comment(`WARN: ${remainingBits} bits remaining after initial allocation. Attempting upgrade...`);
         // This part requires careful handling to add bits without drastically changing allocation
     } else if (remainingBits < 0) {
          // This indicates an issue in the greedy logic - should not happen with the checks
         t.comment(`ERROR: Overallocated bits by ${-remainingBits}. Review allocation logic.`);
         // Need a strategy to downgrade assignments if deficit occurs
     }
     
     // Fill any unassigned indices with the minimum bit size (should ideally not happen if logic is correct)
      let finalTotalBits = 0;
      for(let j=0; j < numHashFunctions; j++){
          if(bitAllocations[j] === undefined){
              t.comment(`WARN: Index ${j} unassigned, defaulting to 2 bits.`);
              bitAllocations[j] = 2;
              allocationCounts[2]++;
              // Note: This might violate targetTotalBits if not accounted for earlier
          }
          finalTotalBits += bitAllocations[j];
      }


    // Report final allocation
    t.comment(`Setup: Bit allocation complete. Final total bits: ${finalTotalBits}`);
    t.comment(`Setup: Allocation distribution: ${JSON.stringify(allocationCounts)}`);
    // Remove the old warning check, as the goal is now to hit the target
    // if (totalBits > 2048) { // OLD check
    //     t.comment(`WARNING: Total allocated bits (${totalBits}) exceeds target (2048). Consider adjusting thresholds.`);
    // }

    t.comment('Setup: Calculating quantile boundaries for each allocation...');
    const boundariesInfo = new Array(numHashFunctions);
    const requiredGrayMaps = new Set();
    for (let j = 0; j < numHashFunctions; j++) {
        const bits = bitAllocations[j];
        const numBuckets = 1 << bits;
        requiredGrayMaps.add(bits);
        // Calculate boundaries specific to this index j based on its numBuckets
        // Need to extract column j from sampleSignatures for calculateQuantileBoundaries
        // (Simpler: calculateQuantileBoundaries could take the full sample + index j)
        // Let's adapt calculateQuantileBoundaries slightly or do it here
        const values_j = sampleSignatures.map(sig => sig[j]);
        boundariesInfo[j] = { 
            bits: bits, 
            boundaries: calculateQuantileBoundaries([values_j], numBuckets)[0] // Pass as single row
        };
    }
    t.comment('Setup: Boundary calculation complete.');

    t.comment('Setup: Generating required Gray code maps...');
    const grayCodeMaps = {};
    for (const bits of requiredGrayMaps) {
        grayCodeMaps[bits] = generateGrayCodeMap(bits);
    }
    t.comment('Setup: Gray code maps generated.');


    // --- Binarization Function (Variable Bit Gray Code) --- 
    function binarizeSignatureVariableGrayCode(signature, boundariesInfo, grayCodeMaps) {
        let finalHash = 0n;
        for (let j = 0; j < numHashFunctions; j++) {
            const info = boundariesInfo[j];
            const bits = info.bits;
            const boundaries = info.boundaries || [];
            const grayMap = grayCodeMaps[bits];
            const numBuckets = 1 << bits;

            const value = signature[j];
            let bucketIndex = 0;
            while (bucketIndex < boundaries.length && value > boundaries[bucketIndex]) {
                bucketIndex++;
            }
            bucketIndex = Math.min(bucketIndex, numBuckets - 1); 

            const grayCodeValue = grayMap[bucketIndex];
            finalHash = (finalHash << BigInt(bits)) | grayCodeValue;
        }
        return finalHash;
    }

    // --- Run Trials --- 
    let totalPrecision10 = 0;
    let totalPrecision1 = 0;
    let totalOverlap10 = 0;

    t.comment(`Running ${numTrials} trials (Variable Learned Gray Code, P@1/10, Overlap@10)...`);
    for (let i = 0; i < numTrials; i++) {
        const queryJson = generateVaryingJson();
        const datasetJson = Array.from({ length: datasetSize }, () => generateVaryingJson());

        const querySig = hasher.generateSketch(queryJson);
        const datasetSigs = datasetJson.map(item => hasher.generateSketch(item));

        // Jaccard distances
        const jaccardDistances = datasetSigs.map(sig => 1 - estimateJaccardSimilarity(querySig, sig));

        // Binarize using variable Gray Code 
        const queryBin = binarizeSignatureVariableGrayCode(querySig, boundariesInfo, grayCodeMaps);
        const datasetBins = datasetSigs.map(sig => binarizeSignatureVariableGrayCode(sig, boundariesInfo, grayCodeMaps));
        const hammingDistances = datasetBins.map(bin => hammingDistance(queryBin, bin)); // Standard Hamming distance still works

        // Get Top K indices
        const jaccardTop10 = getTopKIndices(jaccardDistances, k10);
        const hammingTop10 = getTopKIndices(hammingDistances, k10);
        const jaccardTop1 = getTopKIndices(jaccardDistances, k1);
        const hammingTop1 = getTopKIndices(hammingDistances, k1);

        // Calculate Metrics
        totalPrecision10 += calculatePrecisionAtK(jaccardTop10, hammingTop10, k10);
        totalPrecision1 += calculatePrecisionAtK(jaccardTop1, hammingTop1, k1);
        totalOverlap10 += calculateSetOverlapAtK(jaccardTop10, hammingTop10);
    }
    t.comment('Trials complete (Variable Learned Gray Code).');

    // --- Analysis --- 
    const avgPrecisionAt10 = totalPrecision10 / numTrials;
    const avgPrecisionAt1 = totalPrecision1 / numTrials;
    const avgOverlapAt10 = totalOverlap10 / numTrials;

    t.comment(`Avg Precision@10 (Variable Learned Gray Code): ${avgPrecisionAt10.toFixed(4)}`);
    t.comment(`Avg Precision@1 (Variable Learned Gray Code):  ${avgPrecisionAt1.toFixed(4)}`);
    t.comment(`Avg Set Overlap@10 (Variable Learned Gray Code): ${avgOverlapAt10.toFixed(4)}`);

    // Check if metrics are reasonably high
    t.ok(avgPrecisionAt10 > 0.5, `Average Precision@10 should be reasonably high (> 0.5)`);
    t.ok(avgPrecisionAt1 > 0.1, `Average Precision@1 should be reasonably high (> 0.1)`);
    t.ok(avgOverlapAt10 > 0.4, `Average Set Overlap@10 should be reasonably high (> 0.4)`);

    t.end();
});

// --- Test 4: EMA Estimated Median --- (Placeholder)
// --- Test 5: EMA Estimated Median --- (Placeholder)
test.skip('JSONHash Ordinal Accuracy (EMA Median)', (t) => { // Renamed for consistency
    // TODO: Implement EMA/incremental median logic and comparison
    t.comment('EMA test not yet implemented.');
    t.end();
});

// Add basic sanity tests for JSONHash class itself later
test('JSONHash constructor validates options', (t) => {
    t.throws(() => new JSONHash({ numHashFunctions: 0 }), /numHashFunctions must be a positive integer/, 'Throws on zero numHashFunctions');
    t.throws(() => new JSONHash({ numHashFunctions: 128, numGroups: 3 }), /numHashFunctions must be divisible by numGroups/, 'Throws on non-divisible numHashFunctions/numGroups');
    t.throws(() => new JSONHash({ shingleSize: 0 }), /shingleSize must be at least 1/, 'Throws on zero shingleSize');
    t.doesNotThrow(() => new JSONHash(), 'Does not throw on default options');
    t.end();
}); 