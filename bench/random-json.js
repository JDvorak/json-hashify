import { JSONHashify, generateJSONHashifySketch, compareJSONHashifySketches, estimateJaccardSimilarity } from '../index.js';
import nanobench from 'nanobench';

// Helper to generate somewhat random JSON structures
function generateRandomJson(depth = 3, maxChildren = 5) {
    if (depth <= 0) {
        const type = Math.random();
        if (type < 0.4) return Math.random() * 1000; // Number
        if (type < 0.7) return Math.random().toString(36).substring(2, 15); // String
        return Math.random() > 0.5; // Boolean
    }

    const isArray = Math.random() > 0.5;
    const numChildren = Math.floor(Math.random() * maxChildren) + 1;
    
    if (isArray) {
        const arr = [];
        for (var i = 0; i < numChildren; i++) {
            arr.push(generateRandomJson(depth - 1, maxChildren));
        }
        return arr;
    } else {
        const obj = {};
        for (var i = 0; i < numChildren; i++) {
            const key = Math.random().toString(36).substring(2, 8); // Random key
            obj[key] = generateRandomJson(depth - 1, maxChildren);
        }
        return obj;
    }
}

const ITERATIONS_PER_CASE = 10000; 
const HASHER_OPTIONS = { numHashFunctions: 64, shingleSize: 3 };

// Define benchmark configurations
const configurations = [
    { depth: 2, maxChildren: 3, name: 'Depth 2, Max Children 3' },
    { depth: 3, maxChildren: 5, name: 'Depth 3, Max Children 5' }, 
    { depth: 4, maxChildren: 5, name: 'Depth 4, Max Children 5' },
    { depth: 3, maxChildren: 8, name: 'Depth 3, Max Children 8' },
    { depth: 5, maxChildren: 3, name: 'Depth 5, Max Children 3' }, 
];

// Create a hasher instance specifically for stateful tests
const statefulHasher = new JSONHashify({ ...HASHER_OPTIONS, enableNodeStringCache: true });
const defaultHasher = new JSONHashify(HASHER_OPTIONS); // For generating reference sketches & general use

// --- Reference JSON Objects and Sketches for Comparison Benchmarks ---
const jsonA = {
    name: "Alice",
    age: 30,
    city: "New York",
    hobbies: ["reading", "hiking", "coding"],
    occupation: "Engineer"
};

const jsonB_high_similarity = {
    name: "Alice",
    age: 31, // Slight change
    city: "New York",
    hobbies: ["reading", "hiking", "coding", "swimming"], // Added one
    occupation: "Engineer",
    status: "active" // Added one field
};

const jsonC_low_similarity = {
    vehicle: "Car",
    model: "Tesla Model S",
    year: 2023,
    features: ["autopilot", "electric", "long range"],
    color: "Red"
};

const sketchA = defaultHasher.generateSketch(jsonA);
const sketchB_high = defaultHasher.generateSketch(jsonB_high_similarity);
const sketchC_low = defaultHasher.generateSketch(jsonC_low_similarity);

const COMPARISON_ITERATIONS = 5000; // Fewer iterations for comparison tests

// Run benchmarks for each configuration
configurations.forEach(config => {
    const BASE_BENCHMARK_NAME = `JSONHash (${config.name})`;

    // --- Stateless Benchmark (New Hasher Each Time) ---
    nanobench(`${BASE_BENCHMARK_NAME} - Stateless`, (bench) => {
        const testData = [];
        for(var i = 0; i < ITERATIONS_PER_CASE; i++){
            testData.push(generateRandomJson(config.depth, config.maxChildren));
        }

        bench.start();
        for (var i = 0; i < ITERATIONS_PER_CASE; i++) {
            // Create a new hasher for each sketch to ensure no state carry-over
            const statelessHasher = new JSONHashify(HASHER_OPTIONS); 
            statelessHasher.generateSketch(testData[i]);
        }
        // bench.log('Average time (Stateless): ' + (bench.elapsed() / ITERATIONS_PER_CASE).toFixed(4) + 'ms');
        bench.log('QPS (Stateless): ' + (ITERATIONS_PER_CASE / (bench.elapsed() / 1000)).toFixed(2));
        bench.end();
    });

    // --- Stateful Benchmark (Shared Hasher with Cache) ---
    // For this test, we generate ONE random JSON and process it many times
    // to see the maximum benefit of the cache for repeated node strings.
    nanobench(`${BASE_BENCHMARK_NAME} - Stateful (Cache Hits)`, (bench) => {
        const singleTestData = generateRandomJson(config.depth, config.maxChildren);
        statefulHasher.clearNodeStringCache(); // Clear cache before this specific config run

        // First run to populate the cache (not timed as part of the main loop)
        statefulHasher.generateSketch(singleTestData);

        bench.start();
        for (var i = 0; i < ITERATIONS_PER_CASE; i++) {
            statefulHasher.generateSketch(singleTestData); // Process the same data
        }
        // bench.log('Average time (Stateful Cache Hits): ' + (bench.elapsed() / ITERATIONS_PER_CASE).toFixed(4) + 'ms');
        bench.log('QPS (Stateful Cache Hits): ' + (ITERATIONS_PER_CASE / (bench.elapsed() / 1000)).toFixed(2));
        bench.end();
    });
}); 

// --- Jaccard Similarity Comparison Benchmarks ---
nanobench('Compare Sketches: A vs B (High Sim) - Exact', (bench) => {
    bench.start();
    let sim = 0;
    for (let i = 0; i < COMPARISON_ITERATIONS; i++) {
        sim = defaultHasher.compareSketches(sketchA, sketchB_high);
    }
    bench.log(`Similarity: ${sim.toFixed(4)}`);
    bench.log(`QPS: ${(COMPARISON_ITERATIONS / (bench.elapsed() / 1000)).toFixed(2)}`);
    bench.end();
});

nanobench('Compare Sketches: A vs B (High Sim) - Approx (Th: 0.8, Tol: 0.01)', (bench) => {
    const estimationOptions = { similarityThreshold: 0.8, errorTolerance: 0.01 };
    bench.start();
    let sim = 0;
    for (let i = 0; i < COMPARISON_ITERATIONS; i++) {
        sim = defaultHasher.compareSketches(sketchA, sketchB_high, estimationOptions);
    }
    bench.log(`Similarity: ${sim.toFixed(4)} (Approximation)`);
    bench.log(`QPS: ${(COMPARISON_ITERATIONS / (bench.elapsed() / 1000)).toFixed(2)}`);
    bench.end();
});

nanobench('Compare Sketches: A vs C (Low Sim) - Exact', (bench) => {
    bench.start();
    let sim = 0;
    for (let i = 0; i < COMPARISON_ITERATIONS; i++) {
        sim = defaultHasher.compareSketches(sketchA, sketchC_low);
    }
    bench.log(`Similarity: ${sim.toFixed(4)}`);
    bench.log(`QPS: ${(COMPARISON_ITERATIONS / (bench.elapsed() / 1000)).toFixed(2)}`);
    bench.end();
});

nanobench('Compare Sketches: A vs C (Low Sim) - Approx (Th: 0.8, Tol: 0.01)', (bench) => {
    const estimationOptions = { similarityThreshold: 0.8, errorTolerance: 0.01 }; // Expect early exit to 0.0
    bench.start();
    let sim = 0;
    for (let i = 0; i < COMPARISON_ITERATIONS; i++) {
        sim = defaultHasher.compareSketches(sketchA, sketchC_low, estimationOptions);
    }
    bench.log(`Similarity: ${sim.toFixed(4)} (Approximation)`);
    bench.log(`QPS: ${(COMPARISON_ITERATIONS / (bench.elapsed() / 1000)).toFixed(2)}`);
    bench.end();
});

nanobench('Compare Sketches: A vs C (Low Sim) - Approx (Th: 0.1, Tol: 0.01)', (bench) => {
    const estimationOptions = { similarityThreshold: 0.1, errorTolerance: 0.01 }; // Threshold is low
    bench.start();
    let sim = 0;
    for (let i = 0; i < COMPARISON_ITERATIONS; i++) {
        sim = defaultHasher.compareSketches(sketchA, sketchC_low, estimationOptions);
    }
    bench.log(`Similarity: ${sim.toFixed(4)} (Approximation)`);
    bench.log(`QPS: ${(COMPARISON_ITERATIONS / (bench.elapsed() / 1000)).toFixed(2)}`);
    bench.end();
});

// Example using the compareJsonHashes utility function (less iterations for brevity)
nanobench('compareJSONHashifySketches Utility: A vs B (High Sim) - Approx (Th: 0.8, Tol: 0.01)', (bench) => {
    const estimationOptions = { similarityThreshold: 0.8, errorTolerance: 0.01 };
    bench.start();
    let sim = 0;
    for (let i = 0; i < 1000; i++) { // Fewer iterations for this example
        sim = compareJSONHashifySketches(sketchA, sketchB_high, HASHER_OPTIONS, estimationOptions);
    }
    bench.log(`Similarity: ${sim.toFixed(4)} (Approximation via utility)`);
    bench.log(`QPS: ${(1000 / (bench.elapsed() / 1000)).toFixed(2)}`);
    bench.end();
}); 