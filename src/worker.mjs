import {Buffer} from "node:buffer";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({status: err.status ?? 500}));
    };
    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const {pathname} = new URL(request.url);
      switch (true) {
        case pathname.endsWith("/chat/completions"):
          assert(request.method === "POST");
          return handleCompletions(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/embeddings"):
          assert(request.method === "POST");
          return handleEmbeddings(await request.json(), apiKey)
            .catch(errHandler);
        case pathname.endsWith("/models"):
          assert(request.method === "GET");
          return handleModels(apiKey)
            .catch(errHandler);
        default:
          throw new HttpError("404 Not Found", 404);
      }
    } catch (err) {
      return errHandler(err);
    }
  }
};

class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
  }
}

const fixCors = ({headers, status, statusText}) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return {headers, status, statusText};
};

const handleOPTIONS = async () => {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    }
  });
};

const BASE_URL = "https://generativelanguage.googleapis.com";
const API_VERSION = "v1beta";

// https://github.com/google-gemini/generative-ai-js/blob/cf223ff4a1ee5a2d944c53cddb8976136382bee6/src/requests/request.ts#L71
const API_CLIENT = "genai-js/0.21.0"; // npm view @google/generative-ai version
const makeHeaders = (apiKey, more) => ({
  "x-goog-api-client": API_CLIENT,
  ...(apiKey && {"x-goog-api-key": apiKey}),
  ...more
});

async function handleModels(apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let {body} = response;
  if (response.ok) {
    const {models} = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({name}) => ({
        id: name.replace("models/", ""),
        object: "model",
        created: 0,
        owned_by: "",
      })),
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_EMBEDDINGS_MODEL = "text-embedding-004";

async function handleEmbeddings(req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  if (!Array.isArray(req.input)) {
    req.input = [req.input];
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    req.model = DEFAULT_EMBEDDINGS_MODEL;
    model = "models/" + req.model;
  }
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, {"Content-Type": "application/json"}),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: {parts: {text}},
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let {body} = response;
  if (response.ok) {
    const {embeddings} = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({values}, index) => ({
        object: "embedding",
        index,
        embedding: values,
      })),
      model: req.model,
    }, null, "  ");
  }
  return new Response(body, fixCors(response));
}

const DEFAULT_MODEL = "gemini-2.0-flash";

const thinkingChunks = [];

async function handleCompletions(req, apiKey) {
  thinkingChunks.length = 0;
  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("gemma-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }

  let orgReq = JSON.parse(JSON.stringify(req));

  // 保存原始请求参数
  let originalSystemPrompt = "系统提示词为空";
  const systemMessage = req.messages?.find(m => m.role === "system");
  if (systemMessage) {
    const content = systemMessage.content;
    if (Array.isArray(content)) {
      originalSystemPrompt = content
        .filter(item => item.text && typeof item.text === 'string')
        .map(item => item.text)
        .join('\n');
    } else if (typeof content === 'string') {
      originalSystemPrompt = content;
    }
  }

  let lastUserContent = "";
  const userMessages = req.messages?.filter(m => m.role === 'user');
  if (userMessages?.length > 0) {
    const lastUserMessage = userMessages.pop();
    // 处理不同格式的content
    if (Array.isArray(lastUserMessage.content)) {
      lastUserContent = lastUserMessage.content
        .filter(item => item.type === 'text' && item.text)
        .map(item => item.text)
        .join('\n');
    } else if (typeof lastUserMessage.content === 'string') {
      lastUserContent = lastUserMessage.content;
    }
  }


  console.log("originalReq:", req)
  // console.log("originalSystemPrompt:", originalSystemPrompt)

  // 第一步：发送思考请求
  const thinkingReq = {
    ...req,
    messages: [
      // 保留原始系统提示
      ...req.messages.filter(m => m.role === "system"),
      // 筛选出用户消息并在最后一条前插入新提示
      ...req.messages.filter(m => m.role !== "system").flatMap((msg, index, arr) => {
        if (msg.role === 'user' && index === arr.length - 1) {
          return {
            role: "user",
            content: `
# Original system prompt:

${originalSystemPrompt}

---
# thinking protocol
1. 确认意图
2. 回复思路
3. 输出格式

# User Content:
${lastUserContent}
`
          };
        }
        return msg;
      })
    ]
  };

  // 根据是否为流式请求选择不同的处理方式
  let thinkingContent = "无";
  let thinkingResponse;

  let thinkingReqBody = await transformRequest(thinkingReq);
  switch (true) {
    case model.endsWith(":search"):
      model = model.substring(0, model.length - 7);
    // eslint-disable-next-line no-fallthrough
    case req.model.endsWith("-search-preview"):
      thinkingReqBody.tools = thinkingReqBody.tools || [];
      thinkingReqBody.tools.push({googleSearch: {}});
  }

  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) {
    url += "?alt=sse";
  }

  console.log("thinking request body:", thinkingReqBody)

  thinkingResponse = await fetch(url, {
    method: "POST",
    headers: makeHeaders(apiKey, {"Content-Type": "application/json"}),
    body: JSON.stringify(thinkingReqBody)
  });

  // console.log("thinking response body:", thinkingResponse.text())

  let returnResponseBody = thinkingResponse.body;
  let returnResponse = thinkingResponse;

  if (thinkingResponse.ok) {
    // 生成唯一ID
    let id = generateChatcmplId();

    if (req.stream) {
      // 创建一个TransformStream来处理思考流
      const thinkingStream = thinkingResponse.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
        }));

      // 收集思考内容
      const reader = thinkingStream.getReader();

      // 创建一个新的ReadableStream来发送给用户
      const userStream = new ReadableStream({
        last: [],
        streamIncludeUsage: req.stream,
        model,
        id,
        async start(controller) {
          const transform = transformThinkingResponseStream.bind(this);
          try {
            // 读取并处理思考流
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              let data;
              if (value) {
                try {
                  data = JSON.parse(value);
                } catch (err) {
                  console.error(value);
                  console.error(err);
                  const length = this.last.length || 1; // at least 1 error msg
                  const candidates = Array.from({length}, (_, index) => ({
                    finishReason: "error",
                    content: {parts: [{text: err}]},
                    index,
                  }));
                  data = {candidates};
                }
                const cand = data.candidates[0];
                console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
                cand.index = cand.index || 0; // absent in new -002 models response
                if (!this.last[cand.index]) {
                  controller.enqueue(transform(data, "first"));
                }
                this.last[cand.index] = data;
                if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
                  controller.enqueue(transform(data));
                }
              }
            }

            // 合并所有思考内容
            thinkingContent = thinkingChunks.join("");

            console.log("thinkingContent: ", thinkingContent)
            // 第二步：发送最终请求
            returnResponse = await sendFinalRequest(this, controller);

            controller.close();

          } catch (err) {
            console.error("Error in thinking stream processing:", err);
            controller.error(err);
            await reader.cancel();
          }
        }
      });
      returnResponseBody = userStream.pipeThrough(new TextEncoderStream());
    } else {
      // 解析思考结果
      let thinkingBody = thinkingResponse.text();
      thinkingContent =
        JSON.parse(JSON.stringify({
          choices: JSON.parse(await thinkingBody).candidates.map(transformCandidatesMessage),
        })).choices[0]?.message?.content;

      console.log("thinkingContent: ", thinkingContent)

      returnResponse = await sendFinalRequest(null, null);

      if (returnResponse?.ok) {
        returnResponseBody = await returnResponse.text();
        returnResponseBody = processCompletionsResponse(
          JSON.parse(returnResponseBody),
          model,
          id,
        );
        // 解析处理后的 JSON 对象
        let parsedBody = JSON.parse(returnResponseBody);

        // 在每个 message 中添加 reasoning_content 字段
        parsedBody.choices.forEach(choice => {
          choice.message.reasoning_content = thinkingContent;
        });
        // 将修改后的对象重新转换为 JSON 字符串
        returnResponseBody = JSON.stringify(parsedBody);
      }

    }
  }
  // 返回处理后的流
  let response = new Response(returnResponseBody, fixCors(returnResponse || {status: 500}));
  // console.log("returnResponseBody: ", response.text())
  return response;

  // 定义发送最终请求的函数
  async function sendFinalRequest(info, controller) {
    // 第二步：发送最终请求
    const finalReq = {
      ...orgReq,
      messages: [
        // 保留原始系统提示
        ...orgReq.messages.filter(m => m.role === "system"),
        // 筛选出用户消息并在最后一条前插入新提示
        ...orgReq.messages.filter(m => m.role !== "system").flatMap((msg, index, arr) => {
          if (msg.role === 'user' && index === arr.length - 1) {
            return {
              role: "user",
              content: `
# original system prompt:
${originalSystemPrompt}
---
# User Content:
${lastUserContent}
---
# Thinking process:
${thinkingContent}
---
现在请根据User Content，参考Thinking process，回顾original system prompt，结合这三者以original system prompt的输出要求来组织撰写最终回复，而不是回复思考过程或复述思考过程。
`
            };
          }
          return msg;
        })
      ]
    };
    console.log("final request: ", finalReq)
    let finalReqBody = await transformRequest(finalReq);
    switch (true) {
      case model.endsWith(":search"):
        model = model.substring(0, model.length - 7);
      // eslint-disable-next-line no-fallthrough
      case orgReq.model.endsWith("-search-preview"):
        finalReqBody.tools = finalReqBody.tools || [];
        finalReqBody.tools.push({googleSearch: {}});
    }

    console.log("final request body: ", finalReqBody)

    returnResponse = await fetch(url, {
      method: "POST",
      headers: makeHeaders(apiKey, {"Content-Type": "application/json"}),
      body: JSON.stringify(finalReqBody), // try
    });

    // console.log("final response body: ", returnResponse.text())

    returnResponseBody = returnResponse.body;
    if (returnResponse.ok) {
      // 如果是流式请求且有controller（来自第一步的流处理）
      if (orgReq.stream && controller) {
        const returnResponseStreamReader = returnResponse.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TransformStream({
            transform: parseStream,
            flush: parseStreamFlush,
            buffer: "",
          }))
          .getReader();
        const transform = transformResponseStream.bind(info);
        // 读取并处理最终流
        while (true) {
          const {done, value} = await returnResponseStreamReader.read();
          if (done) break;

          let data;
          if (value) {
            try {
              data = JSON.parse(value);
            } catch (err) {
              console.error(value);
              console.error(err);
              const length = info.last.length || 1; // at least 1 error msg
              const candidates = Array.from({length}, (_, index) => ({
                finishReason: "error",
                content: {parts: [{text: err}]},
                index,
              }));
              data = {candidates};
            }
            const cand = data.candidates[0];
            console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
            cand.index = cand.index || 0; // absent in new -002 models response
            if (!info.last[cand.index]) {
              controller.enqueue(transform(data, "first"));
            }
            info.last[cand.index] = data;
            if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
              controller.enqueue(transform(data));
            }
          }
        }
        toOpenAiStreamFlush(info, controller);
        return returnResponse;
      }
    }
    return new Response(returnResponseBody, fixCors(returnResponse || {status: 500}));
  }
}

const adjustProps = (schemaPart) => {
  if (typeof schemaPart !== "object" || schemaPart === null) {
    return;
  }
  if (Array.isArray(schemaPart)) {
    schemaPart.forEach(adjustProps);
  } else {
    if (schemaPart.type === "object" && schemaPart.properties && schemaPart.additionalProperties === false) {
      delete schemaPart.additionalProperties;
    }
    Object.values(schemaPart).forEach(adjustProps);
  }
};
const adjustSchema = (schema) => {
  const obj = schema[schema.type];
  delete obj.strict;
  return adjustProps(schema);
};

const harmCategory = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_CIVIC_INTEGRITY",
];
const safetySettings = harmCategory.map(category => ({
  category,
  threshold: "BLOCK_NONE",
}));
const fieldsMap = {
  stop: "stopSequences",
  n: "candidateCount", // not for streaming
  max_tokens: "maxOutputTokens",
  max_completion_tokens: "maxOutputTokens",
  temperature: "temperature",
  top_p: "topP",
  top_k: "topK", // non-standard
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
};
const transformConfig = (req) => {
  let cfg = {};
  //if (typeof req.stop === "string") { req.stop = [req.stop]; } // no need
  for (let key in req) {
    const matchedKey = fieldsMap[key];
    if (matchedKey) {
      cfg[matchedKey] = req[key];
    }
  }
  if (req.response_format) {
    switch (req.response_format.type) {
      case "json_schema":
        adjustSchema(req.response_format);
        cfg.responseSchema = req.response_format.json_schema?.schema;
        if (cfg.responseSchema && "enum" in cfg.responseSchema) {
          cfg.responseMimeType = "text/x.enum";
          break;
        }
      // eslint-disable-next-line no-fallthrough
      case "json_object":
        cfg.responseMimeType = "application/json";
        break;
      case "text":
        cfg.responseMimeType = "text/plain";
        break;
      default:
        throw new HttpError("Unsupported response_format.type", 400);
    }
  }
  return cfg;
};

const parseImg = async (url) => {
  let mimeType, data;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText} (${url})`);
      }
      mimeType = response.headers.get("content-type");
      data = Buffer.from(await response.arrayBuffer()).toString("base64");
    } catch (err) {
      throw new Error("Error fetching image: " + err.toString());
    }
  } else {
    const match = url.match(/^data:(?<mimeType>.*?)(;base64)?,(?<data>.*)$/);
    if (!match) {
      throw new HttpError("Invalid image data: " + url, 400);
    }
    ({mimeType, data} = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformMsg = async ({content, tool_calls, tool_call_id}, fnames) => {
  const parts = [];
  if (tool_call_id !== undefined) {
    let response;
    try {
      response = JSON.parse(content);
    } catch (err) {
      console.error("Error parsing function response content:", err);
      throw new HttpError("Invalid function response: " + content, 400);
    }
    if (typeof response !== "object" || response === null || Array.isArray(response)) {
      response = {result: response};
    }
    parts.push({
      functionResponse: {
        id: tool_call_id.startsWith("{") ? null : tool_call_id,
        name: fnames[tool_call_id],
        response,
      }
    });
    return parts;
  }
  if (tool_calls) {
    for (const tcall of tool_calls) {
      if (tcall.type !== "function") {
        throw new HttpError(`Unsupported tool_call type: "${tcall.type}"`, 400);
      }
      const {function: {arguments: argstr, name}, id} = tcall;
      let args;
      try {
        args = JSON.parse(argstr);
      } catch (err) {
        console.error("Error parsing function arguments:", err);
        throw new HttpError("Invalid function arguments: " + argstr, 400);
      }
      parts.push({
        functionCall: {
          id: id.startsWith("{") ? null : id,
          name,
          args,
        }
      });
      fnames[id] = name;
    }
    return parts;
  }
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({text: content});
    return parts;
  }
  // user:
  // An array of content parts with a defined type.
  // Supported options differ based on the model being used to generate the response.
  // Can contain text, image, or audio inputs.
  for (const item of content) {
    switch (item.type) {
      case "text":
        parts.push({text: item.text});
        break;
      case "image_url":
        parts.push(await parseImg(item.image_url.url));
        break;
      case "input_audio":
        parts.push({
          inlineData: {
            mimeType: "audio/" + item.input_audio.format,
            data: item.input_audio.data,
          }
        });
        break;
      default:
        throw new HttpError(`Unknown "content" item type: "${item.type}"`, 400);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({text: ""}); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) {
    return;
  }
  const contents = [];
  // let count = 0;
  let system_instruction;
  const fnames = {}; // cache function names by tool_call_id between messages
  for (const item of messages) {
    if (item.role === "system") {
      system_instruction = {parts: await transformMsg(item)};
    } else {
      if (item.role === "assistant") {
        item.role = "model";
      } else if (item.role === "tool") {
        const prev = contents[contents.length - 1];
        if (prev?.role === "function") {
          prev.parts.push(...await transformMsg(item, fnames));
          continue;
        }
        item.role = "function"; // ignored
      } else if (item.role !== "user") {
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
      }
      // if (count++ % 2 !== 0) {
        contents.push({
          role: item.role,
          parts: await transformMsg(item, fnames)
        });
      // }
      console.log("content", contents.toString())
    }
  }
  if (system_instruction && contents.length === 0) {
    contents.push({role: "model", parts: {text: " "}});
  }
  //console.info(JSON.stringify(contents, 2));
  return {system_instruction, contents};
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function");
    funcs.forEach(adjustSchema);
    tools = [{function_declarations: funcs.map(schema => schema.function)}];
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [req.tool_choice?.function?.name] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return {tools, tool_config};
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateChatcmplId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return "chatcmpl-" + Array.from({length: 29}, randomChar).join("");
};

const reasonsMap = { //https://ai.google.dev/api/rest/v1/GenerateContentResponse#finishreason
  //"FINISH_REASON_UNSPECIFIED": // Default value. This value is unused.
  "STOP": "stop",
  "MAX_TOKENS": "length",
  "SAFETY": "content_filter",
  "RECITATION": "content_filter",
  //"OTHER": "OTHER",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => {
  const message = {role: "assistant", content: []};
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? `{${fc.name}}`,
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        }
      });
    } else {
      message.content.push(part.text);
    }
  }
  message.content = message.content.join(SEP) || null;
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: message,
    logprobs: null,
    finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
  };
};
const transformThinkingCandidates = (key, cand) => {
  const message = {role: "assistant", reasoning_content: []};
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? `{${fc.name}}`,
        type: "function",
        function: {
          name: fc.name,
          arguments: JSON.stringify(fc.args),
        }
      });
    } else {
      message.reasoning_content.push(part.text);
    }
  }
  message.reasoning_content = message.reasoning_content.join(SEP) || null;
  return {
    index: cand.index || 0, // 0-index is absent in new -002 models response
    [key]: message,
    logprobs: null,
    finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
  };
};
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");
const transformThinkingCandidatesDelta = transformThinkingCandidates.bind(null, "delta");

const transformUsage = (data) => ({
  completion_tokens: data.candidatesTokenCount,
  prompt_tokens: data.promptTokenCount,
  total_tokens: data.totalTokenCount
});

const processCompletionsResponse = (data, model, id) => {
  return JSON.stringify({
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now() / 1000),
    model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: transformUsage(data.usageMetadata),
  });
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;

function parseStream(chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) {
      break;
    }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}

function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
  }
}

function transformResponseStream(data, special) {
  const item = transformCandidatesDelta(data.candidates[0]);
  let isStop = false;
  switch (special) {
    case "stop":
      if (item.delta.tool_calls) {
        item.finish_reason = "tool_calls";
      }
      item.delta = {};
      isStop = true;
      break;
    case "first":
      item.finish_reason = null;
      item.delta.content = "";
      delete item.delta.tool_calls;
      break;
    default:
      item.finish_reason = null;
      delete item.delta.role;
  }
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now() / 1000),
    model: this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
  };
  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = isStop ? transformUsage(data.usageMetadata) : null;
  }
  return "data: " + JSON.stringify(output) + delimiter;
}

function transformThinkingResponseStream(data, special) {
  const item = transformThinkingCandidatesDelta(data.candidates[0]);
  if (data.candidates[0]?.content?.parts?.[0]?.text) {
    thinkingChunks.push(data.candidates[0].content.parts[0].text);
  }
  let isStop = false;
  switch (special) {
    case "stop":
      if (item.delta.tool_calls) {
        item.finish_reason = "tool_calls";
      }
      item.delta = {};
      isStop = true;
      break;
    case "first":
      item.finish_reason = null;
      item.delta.content = "";
      delete item.delta.tool_calls;
      break;
    default:
      item.finish_reason = null;
      delete item.delta.role;
  }
  const output = {
    id: this.id,
    choices: [item],
    created: Math.floor(Date.now() / 1000),
    model: this.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
  };
  if (data.usageMetadata && this.streamIncludeUsage) {
    output.usage = isStop ? transformUsage(data.usageMetadata) : null;
  }
  return "data: " + JSON.stringify(output) + delimiter;
}

const delimiter = "\n\n";

function toOpenAiStream(line, controller) {
  const transform = transformResponseStream.bind(this);
  let data;
  try {
    data = JSON.parse(line);
  } catch (err) {
    console.error(line);
    console.error(err);
    const length = this.last.length || 1; // at least 1 error msg
    const candidates = Array.from({length}, (_, index) => ({
      finishReason: "error",
      content: {parts: [{text: err}]},
      index,
    }));
    data = {candidates};
  }
  const cand = data.candidates[0];
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  cand.index = cand.index || 0; // absent in new -002 models response
  if (!this.last[cand.index]) {
    controller.enqueue(transform(data, "first"));
  }
  this.last[cand.index] = data;
  if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(transform(data));
  }
}

function toOpenAiStreamFlush(info, controller) {
  const transform = transformResponseStream.bind(info);
  if (info.last.length > 0) {
    for (const data of info.last) {
      controller.enqueue(transform(data, "stop"));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
