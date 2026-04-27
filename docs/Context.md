一轮对话 原始记录
[system prompt]
[user prompt]
[llm thinking]
[llm toolcall id 1] something
[tool result id 1] something
[text out1]
[thinking]
[llm toolcall id 2] something
[tool result id 2] somthing
[text out2]

我们全量进入session raw 数据库 （每轮增量） -》 这个我们给session search用

我们增量下一轮context
[system prompt] 忽略
[user prompt] 
[assistant] toolcall id = 1
[text out1]
[assistant] toolcall id = 2
[text out2]

这样我们的session search可以让llm在raw sessiondata找，保留了它原来的作用。 同时第二轮的context也足够压缩。

我们的compress在 context上做， raw保留给session search用。
触发压缩的时候，压缩后的上下文不进入 session raw（因为它确实不是raw），它只压缩context windows。