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

const DEFAULT_MODEL = "gemini-1.5-pro-latest";


async function handleCompletions(req, apiKey) {
  let model = DEFAULT_MODEL;
  switch (true) {
    case typeof req.model !== "string":
      break;
    case req.model.startsWith("models/"):
      model = req.model.substring(7);
      break;
    case req.model.startsWith("gemini-"):
    case req.model.startsWith("learnlm-"):
      model = req.model;
  }
  const TASK = req.stream ? "streamGenerateContent" : "generateContent";
  let url = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}`;
  if (req.stream) {
    url += "?alt=sse";
  }


  // 保存原始请求参数
  const originalReq = {...req, stream: req.stream};
  let originalSystemPrompt = "";
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
  originalSystemPrompt = originalSystemPrompt || "无系统提示词";


  console.log("originalReq:", originalReq)
  console.log("originalSystemPrompt:", originalSystemPrompt)

  // 第一步：发送思考请求
  const thinkingReq = {
    ...req,
    stream: req.stream, // 保持与原始请求相同的stream设置
    messages: [
      {
        role: "system",
        content: `
这里是思考协议...
`
      },
      ...req.messages.filter(m => m.role !== "system")
    ]
  };

  // 根据是否为流式请求选择不同的处理方式
  let thinkingContent = "无";
  let thinkingResponse;
  
  if (req.stream) {
    // 流式思考请求处理
    const TASK = "streamGenerateContent";
    let thinkingUrl = `${BASE_URL}/${API_VERSION}/models/${model}:${TASK}?alt=sse`;
    
    thinkingResponse = await fetch(thinkingUrl, {
      method: "POST",
      headers: makeHeaders(apiKey, {"Content-Type": "application/json"}),
      body: JSON.stringify(await transformRequest(thinkingReq))
    });
    
    if (thinkingResponse.ok) {
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
      const thinkingChunks = [];
      
      // 创建一个新的ReadableStream来发送给用户
      const userStream = new ReadableStream({
        async start(controller) {
          try {
            // 读取并处理思考流
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              
              if (value) {
                try {
                  const data = JSON.parse(value);
                  const cand = data.candidates?.[0];
                  if (cand?.content?.parts?.[0]?.text) {
                    thinkingChunks.push(cand.content.parts[0].text);
                    
                    // 创建一个类似OpenAI格式的响应块，但content为null，reasoning_content包含思考内容
                    const openAIChunk = {
                      id: generateChatcmplId(),
                      object: "chat.completion.chunk",
                      created: Math.floor(Date.now() / 1000),
                      model: model,
                      choices: [{
                        index: 0,
                        delta: {
                          role: cand.index === 0 ? "assistant" : undefined,
                          content: null,
                          reasoning_content: cand.content.parts[0].text
                        },
                        finish_reason: null
                      }]
                    };
                    
                    // 发送给用户
                    controller.enqueue("data: " + JSON.stringify(openAIChunk) + delimiter);
                  }
                } catch (err) {
                  console.error("Error parsing thinking stream:", err);
                }
              }
            }
            
            // 合并所有思考内容
            thinkingContent = thinkingChunks.join("");
            
            // 第二步：发送最终请求
            await sendFinalRequest(controller);
            
            // 完成流
            controller.enqueue("data: [DONE]" + delimiter);
            controller.close();
          } catch (err) {
            console.error("Error in thinking stream processing:", err);
            controller.error(err);
          }
        }
      });
      
      // 返回处理后的流
      return new Response(userStream.pipeThrough(new TextEncoderStream()), fixCors(thinkingResponse));
    }
  } else {
    // 非流式思考请求处理
    thinkingResponse = await fetch(`${BASE_URL}/${API_VERSION}/models/${model}:generateContent`, {
      method: "POST",
      headers: makeHeaders(apiKey, {"Content-Type": "application/json"}),
      body: JSON.stringify(await transformRequest(thinkingReq))
    });

    // 解析思考结果
    let thinkingBody = thinkingResponse.body;
    if (thinkingResponse.ok) {
      thinkingBody = await thinkingResponse.text();
      thinkingContent =
        JSON.parse(JSON.stringify({
          choices: JSON.parse(thinkingBody).candidates.map(transformCandidatesMessage),
        })).choices[0]?.message?.content;
    }
  }

  console.log("thinkingContent: ", thinkingContent)

  // 定义发送最终请求的函数
  async function sendFinalRequest(controller = null) {
    // 第二步：发送最终请求
    const finalReq = {
      ...originalReq,
      messages: [
        {
          role: "system",
          content: `
# 根据用户输入产生的思考过程：

${thinkingContent}

# original system prompt:

${originalSystemPrompt}

---

请根据用户输入，参考思考过程，并确保绝对优先遵守original system prompt的指令，结合这三者以original system prompt的输出要求来组织撰写最终回复。`
        },
        ...originalReq.messages.filter(m => m.role !== "system")
      ]
    };
    console.log(finalReq.messages[0].content)
    const response = await fetch(url, {
      method: "POST",
      headers: makeHeaders(apiKey, {"Content-Type": "application/json"}),
      body: JSON.stringify(await transformRequest(finalReq)), // try
    });
    
    // 如果是流式请求且有controller（来自第一步的流处理）
    if (req.stream && controller) {
      if (response.ok) {
        const reader = response.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TransformStream({
            transform: parseStream,
            flush: parseStreamFlush,
            buffer: "",
          }))
          .getReader();
          
        // 读取并处理最终流
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          
          if (value) {
            try {
              const data = JSON.parse(value);
              const cand = data.candidates?.[0];
              if (cand?.content?.parts?.[0]?.text) {
                // 创建一个类似OpenAI格式的响应块，保留第一步的reasoning_content
                const openAIChunk = {
                  id: generateChatcmplId(),
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {
                      role: cand.index === 0 ? "assistant" : undefined,
                      content: cand.content.parts[0].text
                    },
                    finish_reason: cand.finishReason ? reasonsMap[cand.finishReason] || cand.finishReason : null
                  }]
                };
                
                // 发送给用户
                controller.enqueue("data: " + JSON.stringify(openAIChunk) + delimiter);
              }
            } catch (err) {
              console.error("Error parsing final stream:", err);
            }
          }
        }
        
        return null; // 已经在流中处理了响应
      }
    }
    
    return response; // 返回响应供非流式处理使用
  }
  
  // 如果不是流式请求，直接发送最终请求
  if (!req.stream) {
    const response = await sendFinalRequest();
    
    // 生成唯一ID
    let id = generateChatcmplId();
    let body = "";
    
    if (response?.ok) {
      // 非流式请求处理
      body = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
        }))
        .pipeThrough(new TransformStream({
          transform: toOpenAiStream,
          flush: toOpenAiStreamFlush,
          streamIncludeUsage: req.stream_options?.include_usage,
          model, id, last: [],
        }))
        .pipeThrough(new TextEncoderStream());
    } else if (response) {
      body = await response.text();
      body = processCompletionsResponse(
        JSON.parse(body),
        model,
        id,
      );
      // 解析处理后的 JSON 对象
      let parsedBody = JSON.parse(body);

      // 在每个 message 中添加 reasoning_content 字段
      parsedBody.choices.forEach(choice => {
        choice.message.reasoning_content = thinkingContent;
      });
      // 将修改后的对象重新转换为 JSON 字符串
      body = JSON.stringify(parsedBody);
    }
    
    return new Response(body, fixCors(response || {status: 500}));
  }
  
  // 流式请求已在前面处理并返回，如果代码执行到这里，说明出现了错误
  return new Response("Error processing request", fixCors({status: 500, statusText: "Internal Server Error"}));
}

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
      throw new Error("Invalid image data: " + url);
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

const transformMsg = async ({role, content}) => {
  const parts = [];
  if (!Array.isArray(content)) {
    // system, user: string
    // assistant: string or null (Required unless tool_calls is specified.)
    parts.push({text: content});
    return {role, parts};
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
        throw new TypeError(`Unknown "content" item type: "${item.type}"`);
    }
  }
  if (content.every(item => item.type === "image_url")) {
    parts.push({text: ""}); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return {role, parts};
};

const transformMessages = async (messages) => {
  if (!messages) {
    return;
  }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    if (item.role === "system") {
      delete item.role;
      system_instruction = await transformMsg(item);
    } else {
      item.role = item.role === "assistant" ? "model" : "user";
      contents.push(await transformMsg(item));
    }
  }
  if (system_instruction && contents.length === 0) {
    contents.push({role: "model", parts: {text: " "}});
  }
  //console.info(JSON.stringify(contents, 2));
  return {system_instruction, contents};
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
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
  // :"function_call",
};
const SEP = "\n\n|>";
const transformCandidates = (key, cand) => ({
  index: cand.index || 0, // 0-index is absent in new -002 models response
  [key]: {
    role: "assistant",
    content: cand.content?.parts.map(p => p.text).join(SEP),
  },
  logprobs: null,
  finish_reason: reasonsMap[cand.finishReason] || cand.finishReason,
});
const transformCandidatesMessage = transformCandidates.bind(null, "message");
const transformCandidatesDelta = transformCandidates.bind(null, "delta");

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

async function parseStream(chunk, controller) {
  chunk = await chunk;
  if (!chunk) {
    return;
  }
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

async function parseStreamFlush(controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
  }
}

function transformResponseStream(data, stop, first) {
  const item = transformCandidatesDelta(data.candidates[0]);
  if (stop) {
    item.delta = {};
  } else {
    item.finish_reason = null;
  }
  if (first) {
    item.delta.content = "";
  } else {
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
    output.usage = stop ? transformUsage(data.usageMetadata) : null;
  }
  return "data: " + JSON.stringify(output) + delimiter;
}

const delimiter = "\n\n";

async function toOpenAiStream(chunk, controller) {
  const transform = transformResponseStream.bind(this);
  const line = await chunk;
  if (!line) {
    return;
  }
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
    controller.enqueue(transform(data, false, "first"));
  }
  this.last[cand.index] = data;
  if (cand.content) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(transform(data));
  }
}

async function toOpenAiStreamFlush(controller) {
  const transform = transformResponseStream.bind(this);
  if (this.last.length > 0) {
    for (const data of this.last) {
      controller.enqueue(transform(data, "stop"));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
