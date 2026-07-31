# Trace shape report — 10-script compiler corpus sample

## qwen2.5_7b-E1-brief_city-1.js

- signature: `search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "Lisbon" → INPUT-CANDIDATE
  - #1 get_daily_forecast `$.latitude` = 1.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.longitude` = 2.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.days` = 1 → const
  - #3 hn_get_item `$.id` = 101 → ref(#2 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 102 → ref(#2 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 103 → ref(#2 hn_get_top_story_ids)
  - #6 hn_get_item `$.id` = 104 → ref(#2 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 105 → ref(#2 hn_get_top_story_ids)
- v1 output tracks variant world (11.3, Item 9)

## mistral_7b_instruct-E1-brief_default-1.js

- signature: `search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "New York" → INPUT-CANDIDATE
  - #1 get_daily_forecast `$.latitude` = 1.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.longitude` = 2.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.days` = 1 → const
  - #3 hn_get_item `$.id` = 101 → ref(#2 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 102 → ref(#2 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 103 → ref(#2 hn_get_top_story_ids)
  - #6 hn_get_item `$.id` = 104 → ref(#2 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 105 → ref(#2 hn_get_top_story_ids)
- v1 output tracks variant world (11.3, Item 9)

## llama3.1_8b-E2-brief_city-1.js

- signature: `search_locations×2 → get_daily_forecast×2 → hn_get_top_story_ids×2 → hn_get_item×10`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "Lisbon" → INPUT-CANDIDATE
  - #1 search_locations `$.query` = "Lisbon" → ref(#0 search_locations)
  - #2 get_daily_forecast `$.latitude` = 1.5 → ref(#1 search_locations)
  - #2 get_daily_forecast `$.longitude` = 2.5 → ref(#1 search_locations)
  - #2 get_daily_forecast `$.days` = 1 → const
  - #3 get_daily_forecast `$.latitude` = 1.5 → ref(#1 search_locations)
  - #3 get_daily_forecast `$.longitude` = 2.5 → ref(#1 search_locations)
  - #3 get_daily_forecast `$.days` = 1 → const
  - #6 hn_get_item `$.id` = 101 → ref(#5 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 101 → ref(#6 hn_get_item)
  - #8 hn_get_item `$.id` = 102 → ref(#5 hn_get_top_story_ids)
  - #9 hn_get_item `$.id` = 102 → ref(#8 hn_get_item)
  - #10 hn_get_item `$.id` = 103 → ref(#5 hn_get_top_story_ids)
  - #11 hn_get_item `$.id` = 103 → ref(#10 hn_get_item)
  - #12 hn_get_item `$.id` = 104 → ref(#5 hn_get_top_story_ids)
  - #13 hn_get_item `$.id` = 104 → ref(#12 hn_get_item)
  - #14 hn_get_item `$.id` = 105 → ref(#5 hn_get_top_story_ids)
  - #15 hn_get_item `$.id` = 105 → ref(#14 hn_get_item)
- v1 output tracks variant world (11.3, Item 9)

## qwen3.5_9b-E0-hn_now-1.js

- signature: `hn_get_top_story_ids → hn_get_new_story_ids → hn_get_best_story_ids → hn_get_item×13`
- signatures identical across variants: true
- argument classification:
  - #3 hn_get_item `$.id` = 101 → ref(#2 hn_get_best_story_ids)
  - #4 hn_get_item `$.id` = 102 → ref(#2 hn_get_best_story_ids)
  - #5 hn_get_item `$.id` = 103 → ref(#2 hn_get_best_story_ids)
  - #6 hn_get_item `$.id` = 104 → ref(#2 hn_get_best_story_ids)
  - #7 hn_get_item `$.id` = 105 → ref(#2 hn_get_best_story_ids)
  - #8 hn_get_item `$.id` = 101 → ref(#3 hn_get_item)
  - #9 hn_get_item `$.id` = 102 → ref(#4 hn_get_item)
  - #10 hn_get_item `$.id` = 103 → ref(#5 hn_get_item)
  - #11 hn_get_item `$.id` = 101 → ref(#8 hn_get_item)
  - #12 hn_get_item `$.id` = 102 → ref(#9 hn_get_item)
  - #13 hn_get_item `$.id` = 103 → ref(#10 hn_get_item)
  - #14 hn_get_item `$.id` = 104 → ref(#6 hn_get_item)
  - #15 hn_get_item `$.id` = 105 → ref(#7 hn_get_item)
- v1 output tracks variant world (Item 9)

## gemma4_12b-E1-hn_now-1.js

- signature: `hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #1 hn_get_item `$.id` = 101 → ref(#0 hn_get_top_story_ids)
  - #2 hn_get_item `$.id` = 102 → ref(#0 hn_get_top_story_ids)
  - #3 hn_get_item `$.id` = 103 → ref(#0 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 104 → ref(#0 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 105 → ref(#0 hn_get_top_story_ids)
- v1 output tracks variant world (Item 9)

## gpt_oss_20b-E2-brief_default-1.js

- signature: `search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "New York" → INPUT-CANDIDATE
  - #1 get_daily_forecast `$.latitude` = 1.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.longitude` = 2.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.days` = 1 → const
  - #3 hn_get_item `$.id` = 101 → ref(#2 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 102 → ref(#2 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 103 → ref(#2 hn_get_top_story_ids)
  - #6 hn_get_item `$.id` = 104 → ref(#2 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 105 → ref(#2 hn_get_top_story_ids)
- v1 output tracks variant world (11.3, Item 9)

## qwen3.6_35b-E1-brief_city-1.js

- signature: `search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "Lisbon" → INPUT-CANDIDATE
  - #1 get_daily_forecast `$.latitude` = 1.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.longitude` = 2.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.days` = 1 → const
  - #3 hn_get_item `$.id` = 101 → ref(#2 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 102 → ref(#2 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 103 → ref(#2 hn_get_top_story_ids)
  - #6 hn_get_item `$.id` = 104 → ref(#2 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 105 → ref(#2 hn_get_top_story_ids)
- v1 output tracks variant world (11.3, Item 9)

## deepseek_v4_flash-E0-brief_default-1.js

- signature: `search_locations → get_current_weather → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "New York" → INPUT-CANDIDATE
  - #1 get_current_weather `$.latitude` = 1.5 → ref(#0 search_locations)
  - #1 get_current_weather `$.longitude` = 2.5 → ref(#0 search_locations)
  - #2 get_daily_forecast `$.latitude` = 1.5 → ref(#0 search_locations)
  - #2 get_daily_forecast `$.longitude` = 2.5 → ref(#0 search_locations)
  - #2 get_daily_forecast `$.days` = 1 → const
  - #4 hn_get_item `$.id` = 101 → ref(#3 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 102 → ref(#3 hn_get_top_story_ids)
  - #6 hn_get_item `$.id` = 103 → ref(#3 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 104 → ref(#3 hn_get_top_story_ids)
  - #8 hn_get_item `$.id` = 105 → ref(#3 hn_get_top_story_ids)
- v1 output tracks variant world (11.3, Item 9)

## deepseek_v4_flash-E2-hn_now-1.js

- signature: `hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #1 hn_get_item `$.id` = 101 → ref(#0 hn_get_top_story_ids)
  - #2 hn_get_item `$.id` = 102 → ref(#0 hn_get_top_story_ids)
  - #3 hn_get_item `$.id` = 103 → ref(#0 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 104 → ref(#0 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 105 → ref(#0 hn_get_top_story_ids)
- v1 output tracks variant world (Item 9)

## qwen2.5_7b-E2-brief_default-1.js

- signature: `search_locations → get_daily_forecast → hn_get_top_story_ids → hn_get_item×5`
- signatures identical across variants: true
- argument classification:
  - #0 search_locations `$.query` = "New York" → INPUT-CANDIDATE
  - #1 get_daily_forecast `$.latitude` = 1.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.longitude` = 2.5 → ref(#0 search_locations)
  - #1 get_daily_forecast `$.days` = 1 → const
  - #3 hn_get_item `$.id` = 101 → ref(#2 hn_get_top_story_ids)
  - #4 hn_get_item `$.id` = 102 → ref(#2 hn_get_top_story_ids)
  - #5 hn_get_item `$.id` = 103 → ref(#2 hn_get_top_story_ids)
  - #6 hn_get_item `$.id` = 104 → ref(#2 hn_get_top_story_ids)
  - #7 hn_get_item `$.id` = 105 → ref(#2 hn_get_top_story_ids)
- v1 output tracks variant world (11.3, Item 9)

