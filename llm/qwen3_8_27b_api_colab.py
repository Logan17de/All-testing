#!/usr/bin/env python3
"""Compatibility entrypoint.

The public-tunnel launcher has been retired. Colab now keeps vLLM private and
uses the outbound-only Supabase worker implemented in
qwen3_8_27b_supabase_colab.py.
"""

from qwen3_8_27b_supabase_colab import main


if __name__ == "__main__":
    main()
