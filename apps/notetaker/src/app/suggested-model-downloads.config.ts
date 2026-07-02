import type { ManagedModel } from '@notetaker/model-manager';

export type SuggestedModelStarScore =
  | 1
  | 1.5
  | 2
  | 2.5
  | 3
  | 3.5
  | 4
  | 4.5
  | 5;

export interface SuggestedModelScores {
  speed: SuggestedModelStarScore;
  quality: SuggestedModelStarScore;
  size: SuggestedModelStarScore;
}

export interface SuggestedModelFileConfig {
  size: number;
  sourceRepository?: string;
  sourcePath?: string;
  sourceUrl?: string;
}

export interface SuggestedModelQuantizationConfig {
  label: string;
  description: string;
  scores: SuggestedModelScores;
  languageCode?: string[];
  // Optional per-quantization languages supported by this quantization variant
  languages?: string[];
  files: Record<string, number | SuggestedModelFileConfig>;
}

export interface SuggestedModelRepositoryConfig {
  name: string;
  model: ManagedModel;
  quantizations: Record<string, SuggestedModelQuantizationConfig>;
}

export const SUGGESTED_MODEL_DOWNLOADS_CONFIG: Record<
  string,
  SuggestedModelRepositoryConfig
> = {
  'onnx-community/whisper-tiny': {
    name: 'Tiny Whisper',
    model: 'transcription',
    quantizations: {
      fp32: {
        label: 'FP32',
        description: 'Current transformers.js full-precision Whisper tiny model.',
        scores: { speed: 5, quality: 2.5, size: 2 },
        languageCode: ['*'],
        files: {
          'added_tokens.json': 34604,
          'config.json': 2243,
          'generation_config.json': 3772,
          'merges.txt': 493869,
          'normalizer.json': 52666,
          'preprocessor_config.json': 339,
          'quantize_config.json': 10126,
          'special_tokens_map.json': 2194,
          'tokenizer.json': 2480466,
          'tokenizer_config.json': 282683,
          'vocab.json': 1036584,
          'onnx/encoder_model.onnx': 32904992,
          'onnx/decoder_model_merged.onnx': 118553827,
        },
      },
      q8: {
        label: 'Q8',
        description: 'Current transformers.js quantized Whisper tiny model.',
        scores: { speed: 5, quality: 2, size: 4 },
        languageCode: ['*'],
        files: {
          'added_tokens.json': 34604,
          'config.json': 2243,
          'generation_config.json': 3772,
          'merges.txt': 493869,
          'normalizer.json': 52666,
          'preprocessor_config.json': 339,
          'quantize_config.json': 10126,
          'special_tokens_map.json': 2194,
          'tokenizer.json': 2480466,
          'tokenizer_config.json': 282683,
          'vocab.json': 1036584,
          'onnx/encoder_model_quantized.onnx': 10124990,
          'onnx/decoder_model_merged_quantized.onnx': 30719241,
        },
      },
    },
  },
  'onnx-community/whisper-base': {
    name: 'Whisper Base',
    model: 'transcription',
    quantizations: {
      fp32: {
        label: 'FP32',
        description: 'Current transformers.js full-precision Whisper base model.',
        scores: { speed: 4, quality: 3.5, size: 1.5 },
        languageCode: ['*'],
        files: {
          'added_tokens.json': 34604,
          'config.json': 2243,
          'generation_config.json': 3832,
          'merges.txt': 493869,
          'normalizer.json': 52666,
          'preprocessor_config.json': 339,
          'quantize_config.json': 10126,
          'special_tokens_map.json': 2194,
          'tokenizer.json': 2480466,
          'tokenizer_config.json': 282682,
          'vocab.json': 1036584,
          'onnx/encoder_model.onnx': 82468078,
          'onnx/decoder_model_merged.onnx': 208521528,
        },
      },
      q8: {
        label: 'Q8',
        description: 'Current transformers.js quantized Whisper base model.',
        scores: { speed: 4.5, quality: 3, size: 3.5 },
        languageCode: ['*'],
        files: {
          'added_tokens.json': 34604,
          'config.json': 2243,
          'generation_config.json': 3832,
          'merges.txt': 493869,
          'normalizer.json': 52666,
          'preprocessor_config.json': 339,
          'quantize_config.json': 10126,
          'special_tokens_map.json': 2194,
          'tokenizer.json': 2480466,
          'tokenizer_config.json': 282682,
          'vocab.json': 1036584,
          'onnx/encoder_model_quantized.onnx': 23201314,
          'onnx/decoder_model_merged_quantized.onnx': 53693315,
        },
      },
    },
  },
  'onnx-community/whisper-small': {
    name: 'Whisper Small',
    model: 'transcription',
    quantizations: {
      fp32: {
        label: 'FP32',
        description: 'Current transformers.js full-precision Whisper Small model.',
        scores: { speed: 3, quality: 4.5, size: 1 },
        languageCode: ['*'],
        files: {
          'added_tokens.json': 34604,
          'config.json': 2227,
          'generation_config.json': 3893,
          'merges.txt': 493869,
          'normalizer.json': 52666,
          'preprocessor_config.json': 339,
          'quantize_config.json': 10126,
          'special_tokens_map.json': 2194,
          'tokenizer.json': 2480466,
          'tokenizer_config.json': 282683,
          'vocab.json': 1036584,
          'onnx/encoder_model.onnx': 352825870,
          'onnx/decoder_model_merged.onnx': 615324301,
        },
      },
      q8: {
        label: 'Q8',
        description: 'Current transformers.js quantized Whisper small model.',
        scores: { speed: 3.5, quality: 4, size: 2.5 },
        languageCode: ['*'],
        files: {
          'added_tokens.json': 34604,
          'config.json': 2227,
          'generation_config.json': 3893,
          'merges.txt': 493869,
          'normalizer.json': 52666,
          'preprocessor_config.json': 339,
          'quantize_config.json': 10126,
          'special_tokens_map.json': 2194,
          'tokenizer.json': 2480466,
          'tokenizer_config.json': 282683,
          'vocab.json': 1036584,
          'onnx/encoder_model_quantized.onnx': 92326160,
          'onnx/decoder_model_merged_quantized.onnx': 156750845,
        },
      },
    },
  },
  'onnx-community/pyannote-segmentation-3.0': {
    name: 'Pyannote Segmentation 3.0',
    model: 'diarization',
    quantizations: {
      fp32: {
        label: 'FP32',
        description: 'Full-precision segmentation model',
        languageCode: ['*'],
        scores: { speed: 3, quality: 4.5, size: 3.5 },
        files: {
          'config.json': 408,
          'preprocessor_config.json': 158,
          'onnx/model.onnx': 5986908,
        },
      },
      q8: {
        label: 'Q8',
        description: 'Quantized ONNX segmentation model',
        languageCode: ['*'],
        scores: { speed: 4, quality: 4, size: 5 },
        files: {
          'config.json': 408,
          'preprocessor_config.json': 158,
          'onnx/model_quantized.onnx': 1542308,
        },
      }
    },
  },
  'altunenes/speaker-diarization-community-1-onnx': {
    name: 'Pyannote Community-1',
    model: 'diarization',
    quantizations: {
      fp32: {
        label: 'FP32',
        description:
          'Community ONNX export of pyannote/speaker-diarization-community-1',
        scores: { speed: 2.5, quality: 4.5, size: 2.5 },
        languageCode: ['*'],
        files: {
          'config.json': {
            size: 408,
            sourceRepository: 'onnx-community/pyannote-segmentation-3.0',
          },
          'preprocessor_config.json': {
            size: 158,
            sourceRepository: 'onnx-community/pyannote-segmentation-3.0',
          },
          'onnx/model.onnx': {
            size: 5916375,
            sourcePath: 'segmentation-community-1.onnx',
          },
          'onnx/embedding_model.onnx': {
            size: 26544032,
            sourcePath: 'embedding_model.onnx',
          },
        },
      },
    },
  },
  'onnx-community/gemma-4-E2B-it-ONNX': {
    name: 'Gemma 4 E2B',
    model: 'language',
    quantizations: {
      q4: {
        label: 'Q4',
        languageCode: ['*'],
        description: 'Q4 ONNX text-generation files from ONNX Community for browser/WebGPU testing.',
        scores: { speed: 3, quality: 3.5, size: 2 },
        files: {
          'chat_template.jinja': 16317,
          'config.json': 5549,
          'generation_config.json': 238,
          'onnx/decoder_model_merged_q4.onnx': 647599,
          'onnx/decoder_model_merged_q4.onnx_data': 1864102912,
          'onnx/embed_tokens_q4.onnx': 5142,
          'onnx/embed_tokens_q4.onnx_data': 1762656256,
          'preprocessor_config.json': 43,
          'processor_config.json': 1689,
          'tokenizer.json': 19439251,
          'tokenizer_config.json': 18807,
        },
      },
    },
  },
  'onnx-community/gemma-4-E4B-it-ONNX': {
    name: 'Gemma 4 E4B',
    model: 'language',
    quantizations: {
      q4: {
        label: 'Q4',
        description: 'Q4 ONNX text-generation files from ONNX Community for larger browser/WebGPU testing.',
        languageCode: ['*'],
        scores: { speed: 2, quality: 4, size: 1 },
        files: {
          'chat_template.jinja': 16317,
          'config.json': 5741,
          'generation_config.json': 238,
          'onnx/decoder_model_merged_q4.onnx': 814829,
          'onnx/decoder_model_merged_q4.onnx_data': 2093703168,
          'onnx/decoder_model_merged_q4.onnx_data_1': 1286205440,
          'onnx/embed_tokens_q4.onnx': 5134,
          'onnx/embed_tokens_q4.onnx_data': 1839202304,
          'onnx/embed_tokens_q4.onnx_data_1': 396361728,
          'preprocessor_config.json': 43,
          'processor_config.json': 1689,
          'tokenizer.json': 19439251,
          'tokenizer_config.json': 18807,
        },
      },
    },
  },
  'RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl': {
    name: 'wav2vec2 XLS-R 300m NL',
    model: 'text-audio-sync',
    quantizations: {
      fp32: {
        label: 'FP32',
        description:
          'Full-precision Wav2Vec2 CTC model fine-tuned on Dutch Common Voice 8 for transcript-to-timecode alignment.',
        scores: { speed: 1.5, quality: 4.5, size: 1 },
        languageCode: ['nl'],
        files: {
          'config.json': {
            size: 2043,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/config.json',
          },
          'preprocessor_config.json': {
            size: 262,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/preprocessor_config.json',
          },
          'special_tokens_map.json': {
            size: 520,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/special_tokens_map.json',
          },
          'tokenizer_config.json': {
            size: 1192,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/tokenizer_config.json',
          },
          'tokenizer.json': {
            size: 1942,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/tokenizer.json',
          },
          'vocab.json': {
            size: 512,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/vocab.json',
          },
          'added_tokens.json': {
            size: 30,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/added_tokens.json',
          },
          'onnx/model.onnx': {
            size: 1262348908,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/onnx/model.onnx',
          },
        },
      },
      q8: {
        label: 'Q8',
        description:
          'Quantized Wav2Vec2 CTC model fine-tuned on Dutch Common Voice 8 for transcript-to-timecode alignment.',
        scores: { speed: 2, quality: 4, size: 2 },
        languageCode: ['nl'],
        files: {
          'config.json': {
            size: 2043,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/config.json',
          },
          'preprocessor_config.json': {
            size: 262,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/preprocessor_config.json',
          },
          'special_tokens_map.json': {
            size: 520,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/special_tokens_map.json',
          },
          'tokenizer_config.json': {
            size: 1192,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/tokenizer_config.json',
          },
          'tokenizer.json': {
            size: 1942,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/tokenizer.json',
          },
          'vocab.json': {
            size: 512,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/vocab.json',
          },
          'added_tokens.json': {
            size: 30,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/added_tokens.json',
          },
          'onnx/model_quantized.onnx': {
            size: 355022393,
            sourceUrl: '/assets/models/RuudVelo/wav2vec2-large-xls-r-300m-cv8-nl/onnx/model_quantized.onnx',
          },
        },
      },
    },
  },
  'onnx-community/wav2vec2-base-960h-ONNX': {
    name: 'wav2vec2 base 960h',
    model: 'text-audio-sync',
    quantizations: {
      fp32: {
        label: 'FP32',
        description:
          'Full-precision Wav2Vec2 CTC model. Suitable for forced-alignment experiments, but alignment is not wired into the engine yet.',
        scores: { speed: 2.5, quality: 4, size: 1 },
        languageCode: ['en'],
        files: {
          'config.json': 2157,
          'preprocessor_config.json': 215,
          'quantize_config.json': 312,
          'special_tokens_map.json': 96,
          'tokenizer.json': 2187,
          'tokenizer_config.json': 1178,
          'vocab.json': 358,
          'onnx/model.onnx': 377911891,
        },
      },
      q8: {
        label: 'Q8',
        description:
          'Quantized Wav2Vec2 CTC model for smaller local alignment experiments. Alignment is not wired into the engine yet.',
        scores: { speed: 3.5, quality: 3.5, size: 3.5 },
        languageCode: ['en'],
        files: {
          'config.json': 2157,
          'preprocessor_config.json': 215,
          'quantize_config.json': 312,
          'special_tokens_map.json': 96,
          'tokenizer.json': 2187,
          'tokenizer_config.json': 1178,
          'vocab.json': 358,
          'onnx/model_quantized.onnx': 95212816,
        },
      },
    },
  },
};
