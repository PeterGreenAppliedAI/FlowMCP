# Benchmark data manifest — frozen 2026-07-31

Primary analysis set: 440 runs (296 agentic + 144 code-mode). Everything else is
retained raw for auditability and explicitly superseded or auxiliary below.
Counts and checksums below are generated from the files themselves

| file | runs | sha256 | status |
|---|---|---|---|
| code-results-2026-07-31T18-53-00.json | 3 | 904fd7d4490ec2c0 | auxiliary: smoke (pre-fix runner) |
| code-results-2026-07-31T19-17-32.json | 3 | 9c895333cbc29aeb | auxiliary: smoke (pre-schema fix) |
| code-results-2026-07-31T19-19-37.json | 3 | bc9370c29c2a8725 | unclassified |
| code-results-2026-07-31T20-47-44.json | 144 | bf35c6ac75b946b3 | SUPERSEDED: schema-less code-mode run (harness commit 6871c9d) |
| code-results-2026-07-31T20-51-17.json | 3 | ac52ad066633081f | unclassified |
| code-results-2026-07-31T21-29-23.json | 144 | be5a757cf48931f9 | PRIMARY: wave E final (harness 7e4e5b7) |
| results-2026-07-31T16-39-44.json | 2 | 1d385c6da1ba56a7 | auxiliary: smoke cells (2 runs) |
| results-2026-07-31T16-58-47.json | 72 | b53c3f4e8dd7aa19 | PRIMARY wave 1 (12 gpt-oss runs within are SUPERSEDED by wave 3) |
| results-2026-07-31T17-09-20.json | 36 | be52ad3445c90b99 | PRIMARY: wave 2 |
| results-2026-07-31T17-35-17.json | 12 | 5c44d81c57fbc1e7 | PRIMARY: wave 3 (supersedes wave-1 gpt-oss) |
| results-2026-07-31T18-13-43.json | 28 | 95d78fd5f7224322 | PRIMARY: wave 4a (deepseek A/B/C/D) |
| results-2026-07-31T18-19-44.json | 112 | 1cf0c65707cb246e | PRIMARY: wave 4b (C/D, 7 models) |
| results-2026-07-31T18-59-04.json | 48 | 72b779839419bab9 | PRIMARY: wave 5 (R) |
| transcripts-2026-07-31T18-13-43.json | 28 | 02ae4373f7634662 | transcripts (waves 4-5) |
| transcripts-2026-07-31T18-19-44.json | 112 | a0f3ffa8d0079cfd | transcripts (waves 4-5) |
| transcripts-2026-07-31T18-59-04.json | 48 | 45f7c006bda1af2f | transcripts (waves 4-5) |

Total records across all files: 798.
Harness commits per wave: 1-2 cf56b01 · 3 5ce273e · 4 847bbf8 · 5 8d464e9 · E-final 7e4e5b7 (superseded E at 6871c9d).
`code-scripts/` holds the 101 captured successful code-mode scripts (the compiler corpus).
