from qwen38_flash_freetoken.serve import _parse_tool_calls


def test_qwen_tool_call_parser():
    text = 'Before\n<tool_call>{"name":"read_file","arguments":{"path":"a.py"}}</tool_call>'
    content, calls = _parse_tool_calls(text)
    assert content == "Before"
    assert len(calls) == 1
    assert calls[0]["function"]["name"] == "read_file"
    assert '"path":"a.py"' in calls[0]["function"]["arguments"]
