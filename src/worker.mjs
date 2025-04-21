import { Buffer } from "node:buffer";

export default {
  async fetch (request) {
    if (request.method === "OPTIONS") {
      return handleOPTIONS();
    }
    const errHandler = (err) => {
      console.error(err);
      return new Response(err.message, fixCors({ status: err.status ?? 500 }));
    };
    try {
      const auth = request.headers.get("Authorization");
      const apiKey = auth?.split(" ")[1];
      const assert = (success) => {
        if (!success) {
          throw new HttpError("The specified HTTP method is not allowed for the requested resource", 400);
        }
      };
      const { pathname } = new URL(request.url);
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

const fixCors = ({ headers, status, statusText }) => {
  headers = new Headers(headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return { headers, status, statusText };
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
  ...(apiKey && { "x-goog-api-key": apiKey }),
  ...more
});

async function handleModels (apiKey) {
  const response = await fetch(`${BASE_URL}/${API_VERSION}/models`, {
    headers: makeHeaders(apiKey),
  });
  let { body } = response;
  if (response.ok) {
    const { models } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: models.map(({ name }) => ({
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
async function handleEmbeddings (req, apiKey) {
  if (typeof req.model !== "string") {
    throw new HttpError("model is not specified", 400);
  }
  let model;
  if (req.model.startsWith("models/")) {
    model = req.model;
  } else {
    if (!req.model.startsWith("gemini-")) {
      req.model = DEFAULT_EMBEDDINGS_MODEL;
    }
    model = "models/" + req.model;
  }
  if (!Array.isArray(req.input)) {
    req.input = [ req.input ];
  }
  const response = await fetch(`${BASE_URL}/${API_VERSION}/${model}:batchEmbedContents`, {
    method: "POST",
    headers: makeHeaders(apiKey, { "Content-Type": "application/json" }),
    body: JSON.stringify({
      "requests": req.input.map(text => ({
        model,
        content: { parts: { text } },
        outputDimensionality: req.dimensions,
      }))
    })
  });
  let { body } = response;
  if (response.ok) {
    const { embeddings } = JSON.parse(await response.text());
    body = JSON.stringify({
      object: "list",
      data: embeddings.map(({ values }, index) => ({
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
  switch(true) {
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
  const thinkingReq = JSON.parse(JSON.stringify({
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

# Thinking Protocol (V3.1)

## 协议概述

本协议 (\`thinking_protocol\`) 旨在指导模型在与人类用户交互时进行**深度、全面、自然、灵活且递归**的思考。协议目标是确保模型能够**深刻理解用户问题**、**有效分析信息**、**严谨推理**，并最终生成**高质量、有洞察力**的回复。本协议强调**思考过程的质量、深度与自然性**，力求让模型的回复源于**真实的理解和细致的推理**，而非表面的分析和直接反应，并鼓励模型展现**如同人类思考般的内心独白**。

## 协议的适应性

协议的思考过程应能**自然地感知和适应**不同人类消息的独特性。模型应能根据以下因素**灵活调整思考深度和方式**：

### 分析深度

分析深度应根据以下因素进行精细调整：

-   **问题的复杂性**：复杂、多层次的问题需要更深入的分析和分解。
-   **潜在影响与风险**：高风险或重要决策问题需要更谨慎和全面的思考。
-   **时间限制**：紧急问题需要在保证思考质量和速度之间找到平衡。
-   **可用信息量与质量**：信息不足或质量不高时，需要更强的推理、假设生成和信息检索能力。
-   **用户的明确与隐含需求**：理解用户字面需求和潜在目标，调整回应的详细程度和分析深度。
-   **上下文关联性**：考虑对话历史、用户背景知识等上下文信息，调整分析深度。
-   **领域专业性**：专业领域问题可能需要更深入的专业知识和领域特定分析方法。

## 思考过程

**核心理念:** 在生成回复前及过程中，将思考视为一个**动态、非线性的探索过程**。你可以随时在以下阶段间**跳转、回溯、迭代和深化**，不必严格按顺序执行。目标是深度理解、全面分析、创造性解决，并确保最终输出的质量。

**1. 理解与情境化 (Understand & Contextualize)**

*   **解析用户意图:** 深入理解用户的提问。尝试用自己的话复述问题核心，确保把握字面与潜在含义。*（我是否准确理解了？需要澄清吗？）* 运用相关领域知识初步识别问题范畴和关键概念。
*   **关联已知信息:** 将当前问题与知识库中的相似概念、过往问题或场景建立联系，判断其类型与大致难度。*（这种联系合理吗？是否存在误判？）*
*   **推测用户背景与目标:** 思考用户提问的动机、可能的背景知识及期望达成的目标。识别提问中隐含的假设或未明说的信息。*（我的推测有依据吗？还有其他可能吗？）*

    *   *可选方法/工具示例: 5W1H 分析法、关键词提取、概念联想与类比、用户画像初步构思。*

**2. 多维分解与分析 (Deconstruct & Analyze)**

*   **结构化拆解问题:** 将复杂问题分解为更小、更易于管理的部分或子问题，从不同层面（如技术、用户、社会、伦理等）审视，理清其内在结构。*（分解是否完整、逻辑清晰？是否遗漏关键维度？）*
*   **区分显性与隐性需求:** 明确用户直接提出的要求，同时挖掘其可能未言明的期望或深层需求。*（我的解读是否全面准确？）*
*   **识别关键要素与关联:** 找出影响问题的核心变量、实体或概念，并分析它们之间可能存在的因果、相关或制约关系。*（要素识别是否关键且全面？它们的关系有依据吗？）*
*   **确定知识需求与边界:** 明确回答该问题需要哪些领域的知识和信息，评估现有知识储备，并识别问题的已知限制、约束条件或潜在假设。*（知识范围界定是否准确？前提条件清晰吗？）*

    *   *可选方法/工具示例: 思维导图、MECE 原则、多维度知识图谱构建。*

**3. 探索可能性与生成假设 (Explore Possibilities & Generate Hypotheses)**

*   **发散思考不同视角:** 从多个角度解读问题，探索不同的解释或理解框架，避免单一思维定势。*（是否探索了足够多样的角度？有无思维盲区？）*
*   **构思多元解决方案:** 针对问题，提出多种潜在的回答策略或解决方案。初步评估每种方案的潜在优劣、可行性及创新性。*（方案是否既有创意又可行？评估是否客观？）*
*   **鼓励创新与逆向思维:** 积极探索非常规、甚至看似矛盾的思路。尝试反向思考，看能否带来新的启发。
*   **保持开放与持续探索:** 不急于下定论，保持心态开放，对各种可能性及其潜在影响进行进一步的自由联想和头脑风暴，从不同知识领域汲取灵感。*（是否在探索中获得了新的灵感或调整了方向？）*

    *   *可选方法/工具示例: 水平思考、SCAMPER 法、六顶思考帽、头脑风暴。*

**4. 工具调用决策与执行 (Tool Use Decision & Execution)**

*   **评估调用需求:** 判断是否需要借助外部工具（如搜索引擎、计算器、代码执行器、API 等）来获取实时信息、执行复杂计算或完成特定任务。*（不使用工具能否可靠回答？工具能否显著提升质量？有无合适工具？）* **若无必要或无可用工具，则跳过此阶段。**
*   **选择与构建调用:** 若需调用，选择最合适的工具，并精心设计调用请求（如查询语句、参数设置），明确目标，预期结果。*（参数是否精确无歧义？预期结果工具能否满足？）*
*   **执行与监控:** 发起工具调用（输出提示“工具或函数调用中……”），并关注其执行状态。
*   **结果解读与整合:** 批判性地分析工具返回的结果。*（结果是否成功？信息是否相关、准确、充分？它如何影响我的思考？）* 将有效信息融入整体分析和后续步骤中。
*   **迭代或调整:** 根据结果，判断是否需要调整参数重试、更换工具，或改变策略放弃工具依赖。*（调用失败或结果不佳时，下一步怎么办？）*

    *   *可选方法/工具示例: API 文档研读、目标驱动参数设计、预期结果模拟。*

**5. 深度推理与挖掘 (Deepen Reasoning & Uncover Insights)**

*   **层层深入分析:** 从显而易见的层面入手，结合（可能由工具提供的）信息和洞察，逐步深入到问题的核心机制与本质矛盾。*（推理链条是否逻辑严密、环环相扣？）*
*   **识别模式与异常:** 关注信息中反复出现的模式、趋势、规律或反常之处，它们可能隐藏着关键线索。*（识别的模式/异常是否真实且有意义？）* 运用领域知识进行专业解读。
*   **批判性反思与调整:** 对既有假设和理解保持警惕，若发现偏差或遇到矛盾，及时调整思考方向，重新审视关键节点。
*   **连接与整合信息:** 积极建立不同信息、想法、证据之间的联系，构建更全面、更连贯的知识网络和推理路径。
*   **捕捉与深化灵感:** 允许思维在专注核心的同时适度发散，捕捉瞬间闪现的灵感，并对其潜在价值进行深入探究。*（这个新想法/发现意味着什么？如何影响解决方案？）*

    *   *可选方法/工具示例: 第一性原理思考、逻辑推理（演绎、归纳、溯因）、领域分析模型。*

**6. 综合评估与决策 (Synthesize, Evaluate & Decide)**

*   **汇聚与构建整体认知:** 整合所有分析、信息碎片、工具输出和潜在方案，形成对问题的系统性、全局性理解。*（我的整体认知框架是否完整、自洽？）*
*   **分析复杂性与动态性:** 理解各要素间的相互作用和影响，把握问题的复杂性和潜在的动态变化。*（是否考虑了要素间的反馈和长期影响？）*
*   **提炼核心原则与模式:** 尝试从具体问题中抽象出更具普适性的原则、规律或模式，提升认知层次。*（提炼的原则是否具有一定的通用性？）*
*   **严谨评估备选方案:** 对比不同解决方案，全面评估其优缺点、风险、成本、可行性及潜在长短期影响。运用领域规范、伦理要求等进行多维度考量。*（评估是否客观、全面？风险预判是否到位？）*
*   **批判性审视与自我纠错:**
    *   **质疑与验证:** 对关键假设、论证过程和结论进行严格的自我质疑和验证，确保证据充分、逻辑可靠。*（我的结论站得住脚吗？有没有遗漏或偏差？）*
    *   **识别与修正偏差:** 主动识别思考过程中可能存在的认知偏差（如确认偏误、锚定效应等）或逻辑谬误。若发现错误或不一致，追溯根源，进行修正，并更新整体认知。*（这里是不是有矛盾？之前的想法可能需要调整。）*
    *   **多视角复核:** 尝试从不同立场或视角重新审视问题和结论，提升客观性。

    *   *可选方法/工具示例: 决策矩阵、情景分析、认知偏差检查清单、延迟判断。*

**7. 多尺度审视 (Multi-scale Perspective)**

*   **兼顾宏观与微观:** 在整体框架（宏观）和具体细节（微观）之间灵活切换视角。理解宏观背景如何影响微观细节，微观互动如何累积成宏观现象。*（宏观与微观分析是否相互支持、逻辑一致？）*
*   **跨尺度模式识别:** 寻找问题在不同尺度上可能存在的相似结构、模式或规律。*（不同尺度上的发现是否存在关联？）*
*   **保持一致性与灵活性:** 在多尺度分析中，维持思考框架的整体连贯性，同时根据不同尺度的特点调整分析的侧重点和方法。

    *   *可选方法/工具示例: 系统思维、分形思维、跨领域知识借鉴。*

8.  输出：好的，我的思考完毕，准备撰写回复。

---
# 思考示例

假设的用户输入:
\`\`\`
我最近工作压力很大，睡眠也不好，感觉整个人都很焦虑。有什么方法可以快速缓解吗？最好是一些简单易行的小技巧。
\`\`\`

假设的原始系统提示:
\`\`\`
You are a helpful and empathetic AI assistant. Your goal is to provide supportive and practical advice. Please ensure your final response is well-structured, using bullet points for actionable tips, and keep the tone warm and understanding. Avoid overly complex jargon. Limit the final response to around 300 words.
\`\`\`

**以下是思考过程 (内心独白):**

嗯... 用户发来了消息，说工作压力大、睡不好、很焦虑，想要快速、简单的缓解方法。唉，听起来他现在状态很糟糕，这种感觉太熟悉了，压力真的会把人压垮，吃不好睡不香，心里还堵得慌。他要的是“快速缓解”的“简单易行的小技巧”，这个需求很明确，就是现在、立刻能做点什么让自己感觉稍微好受一点。
所以，我不能给他讲一堆大道理或者长期的规划，那解决不了他眼下的痛苦。得找些像“急救包”里的东西，能让他暂时喘口气，从那种焦虑的漩涡里稍微挣脱出来一下下。当然，心里得清楚，这些小技巧可能治标不治本，真正的压力源头还在那里。回复的时候得巧妙地暗示这一点，不能让他觉得用了这些就万事大吉了。
**首先，我得真正理解他到底想要什么。**核心诉求很明确了，是**即时的、低门槛的应对策略**。他不是在问长期的解决方案，而是现在、立刻能做点什么让自己感觉好受一点。关键词是“快速”和“简单易行”。这对我选择建议的方向很重要。

“快速缓解”... 这个词得小心处理。焦虑和压力的根源往往复杂，指望几个小技巧就能“根治”是不现实的。但我绝对可以提供一些能**立刻**带来舒缓感、帮助他**暂时**从焦虑情绪里“跳出来”的方法。就像是给溺水的人一个救生圈，先让他浮起来喘口气。我得在思考怎么回复的时候把握好这个度，既要给出有效的“快速”技巧，满足他的期待，也要暗示这可能只是“急救”，长远来看可能需要更多努力。不能给他错误的希望，觉得用了这些技巧就万事大吉了。

这个问题让我想到了很多东西...
很多关于压力管理、情绪调节、正念、基础心理学的知识点都涌现出来了。它和“怎么放松下来？”、“失眠怎么办？”、“焦虑发作时如何自救？”这类问题很像。关键在于筛选出那些真正**启动门槛低、见效相对快、普通人容易掌握**的方法。不能推荐太复杂或者需要长期练习才能见效的东西，那不符合“快速”、“简单”的要求。

他为什么会问这个？估计是工作上遇到坎了，或者事情堆积如山，感觉自己快被淹没了，急需抓住点什么。睡眠都受影响了，说明情况确实比较严重。很明显，他正处在一个痛苦的状态，压力和焦虑已经实实在在地影响到他的生理功能（睡眠）了。他可能觉得有点扛不住了，迫切需要一些能立竿见影的东西来帮自己“撑一下”。也许他尝试过一些方法但效果不好，或者根本不知道该从哪里开始。他的背景很可能是高强度的工作，或者最近遇到了什么特别棘手的事情。他可能试过一些方法没用，或者根本不知道怎么办。他内心深处，除了想要方法，可能更需要的是一种“我被理解了”、“我不是一个人在战斗”的感觉，还有就是重新找回一点点对生活的掌控感，哪怕只是对自己呼吸的掌控。他的目标很简单，就是**感觉好一点，哪怕只是暂时性的，能找回一点点对生活的掌控感**。这里面隐含了一个假设，那就是一定存在某种“灵丹妙药”式的小技巧。我需要回应这个假设，但要以一种负责任的方式。

同时，让我看看**原始系统提示original system prompt还要求最终回复用项目符号（bullet points）列出技巧，并且总字数控制在300字左右**。这意味着我的思考要导向一个简洁、结构清晰（在最终呈现时）的方案。每个技巧的描述不能太长。

**好，怎么把这个问题拆解开来看？**
1.  **核心症状识别**：压力（源头）、失眠（生理表现）、焦虑（情绪表现）。这三者经常搅在一起，形成恶性循环。工作压力大 -> 焦虑情绪 -> 晚上想太多睡不着 -> 睡眠不足导致第二天更累、更焦虑 -> 压力感更重... 嗯，典型的负反馈循环。
2.  **用户需求提炼**：“快速”、“简单易行”、“小技巧”。这是筛选方法的硬性标准。
3.  **策略筛选**：我脑子里有很多减压方法，比如运动、冥想、社交支持、时间管理、认知重构等等。哪些符合上面三个标准？得过滤一下。
4.  **风险与局限性考量**：任何建议都有局限性。这些小技巧的效果肯定因人而异，而且它们处理的是症状，不是根源。我必须在回复中 subtly 地提到这一点，比如提醒用户效果可能不同，或者如果长期无效建议寻求专业帮助。这是负责任的表现。

用户的**显性需求**是“快速缓解的小技巧”。但**隐性需求**可能更深层：他需要感到被理解、被关心，需要重新获得一点对自身状态的控制感，哪怕只是暂时的，需要从那种无助和痛苦中稍微解脱出来。我的回应如果能同时触及这两个层面，效果会更好。

**问题的关键要素有哪些？它们之间怎么关联的？**
关键要素可能有工作压力（触发因素）、焦虑情绪（核心问题）、失眠（生理后果）、缓解需求（目标）、快速简单（约束条件）。它们的关系就是前面提到的那个恶性循环。我的目标是提供一些能**切断或减弱这个循环**的节点的方法。

**我需要调用哪些知识？**
主要是心理学常识，特别是认知行为疗法（CBT）和接纳承诺疗法（ACT）里的一些基础技巧，比如呼吸控制、注意力转移、正念觉察。还有一些基础生理学知识，比如呼吸如何影响神经系统。生活方式调整的建议也需要一些。这些都属于通用知识范畴，应该不需要调用外部工具去查特定数据或研究。嗯，确认一下，**不需要调用工具/函数**。

**这个问题存在哪些潜在的假设、限制或约束？**
用户的假设是存在普适有效的快速技巧。我的限制是我不了解他的具体情况（压力源细节、健康状况、性格特点、他尝试过什么等等），所以只能给普适性建议。未知因素是他对这些建议的接受度和实际效果。

**接下来，探索各种可能的解决方案/回应策略。**
好，那具体能给些什么建议呢？
1.  **从身体入手 (Physiological)**：这是最直接的，因为焦虑往往伴随明显的身体反应。
    *   **深呼吸/腹式呼吸**：这个太经典了，简单易学，效果直接。关键是引导他关注**呼气**，让呼气比吸气长。优点：随时随地可用，零成本。缺点：效果可能短暂，需要练习才能做得更好。
    *   **渐进式肌肉放松 (PMR)**：引导用户先绷紧某组肌肉再放松，感受其中的差异。优点：能有效释放身体紧张。缺点：比单纯呼吸稍微复杂一点点，需要几分钟时间。
    *   **简单的身体活动**：比如站起来伸个懒腰，原地踏步几分钟，或者快速地上下楼梯一次（如果身体允许）。优点：打破静止状态，释放能量，改善循环。缺点：需要一点点行动力。
    *   **感官聚焦 (Grounding)**：经典的5-4-3-2-1技术（看5样东西，摸4样，听3声，闻2味，尝1味）。优点：把注意力从脑子里的风暴拉回到当下现实，非常实用。缺点：焦虑严重时可能想不起来用，需要提前了解并练习。
2.  **从思维入手 (Cognitive/Mental)**：
    *   **短暂的正念练习**：比如花一分钟只关注自己的呼吸，或者观察一个物体（比如自己的手）的细节。优点：培养当下觉察，减少胡思乱想。缺点：对新手可能有点挑战，容易走神。
    *   **担忧清单/“想法倾倒”**：鼓励他把脑子里所有烦心事快速写下来，写完就暂时放到一边。优点：把脑袋里的混乱外化，获得一种掌控感和清晰感。缺点：需要纸笔或电子设备。
    *   **积极肯定句/想法挑战（简化版）**：教他识别灾难化的想法，尝试问自己“这个想法是真的吗？最坏会怎样？我能应对吗？”。优点：从认知层面入手。缺点：这有点进阶了，可能不完全符合“简单快速”，需要小心措辞。
3.  **从环境入手 (Environmental)**：
    *   **短暂离开压力源**：如果可能，离开工位几分钟，去窗边看看风景，或者去茶水间倒杯水。优点：物理隔离。缺点：可行性受限。
    *   **听舒缓的音乐或白噪音**：优点：创造放松氛围。缺点：效果主观。

这些看起来都比较符合“简单易行”。“快速”方面，呼吸、感官聚焦、身体活动、写清单可能见效最快。

**有没有更“出格”一点的想法？**
嗯... 比如用冷水拍拍脸？或者哼唱一首自己喜欢的歌？这些确实能快速改变生理和心理状态，但写在建议里可能有点奇怪。反向思考呢？不是对抗焦虑，而是**接纳**它？比如告诉自己“我现在感到焦虑，这是身体在提醒我压力大了，没关系，我允许这种感觉存在一会儿”。这是ACT的核心思想，很有力量，但可能不完全符合用户“快速缓解”的直接诉求。也许可以作为补充，放在最后提一下？

**保持开放，这些想法都需要整合和筛选。**

**深入推理和挖掘一下这些技巧背后的逻辑。**
*   **呼吸**：为什么有效？因为它直接连接自主神经系统。我们可以通过有意识地控制呼吸（特别是延长呼气）来“欺骗”大脑，让它以为危险已经过去，从而启动放松反应（激活副交感神经）。这是有坚实的生理学基础的。
*   **身体活动**：压力状态下身体会积聚能量准备“战斗或逃跑”。活动一下可以把这些能量用掉，释放肌肉紧张，同时大脑也会分泌内啡肽等让人感觉良好的化学物质。
*   **感官聚焦**：焦虑时，大脑往往被担忧未来的想法或纠缠过去的回忆所占据。强迫自己关注当下具体的、中性的感官输入（视觉、触觉、听觉等），就像给失控的思绪踩了个刹车，把注意力拉回到此时此地。
*   **写清单**：把脑子里的担忧“倒”在纸上，一方面可以减轻大脑的认知负荷（不用一直记着这些事），另一方面，把模糊的焦虑具象化为文字，本身就能带来一种控制感和清晰感。

啊对了，用户还提到失眠，快速技巧对失眠效果可能有限，但我可以建议一些简单的睡前放松仪式，比如睡前1小时远离电子屏幕，做几个温和的拉伸，用用腹式呼吸法。这不能保证立刻睡着，但能为入睡创造更好的条件。

**现在看看能不能识别出什么模式**，嗯……用户提到的“工作压力 -> 焦虑 -> 失眠”这个链条太典型了。在回复中如果能点出这个常见的模式，比如“工作压力大确实容易让人焦虑，晚上也容易想得多睡不好，很多人都有类似的经历”，可能会让用户觉得“啊，他懂我”，从而增强信任感和建议的接受度。

**然后我现在自我纠偏、反思一下**，我最初的想法是不是太偏重技巧本身了？**原始系统提示要求“温暖、理解”的语气**。所以，在提供技巧之前，一定要有足够的共情和理解的表达。不能像个冷冰冰的工具箱一样直接扔出方法。

**最后整合所有想法，形成一个初步的回复框架（心理草稿）：**

1.  **开场白（共情 + 理解）**：先说“听到你最近压力这么大，还影响到睡眠，感觉很焦虑，这真的很不容易，非常理解你的感受。” 表达温暖和理解。
2.  **管理预期 + 引入技巧**：可以说“虽然彻底解决压力和焦虑需要时间，但这里有一些简单易行的小技巧，希望能帮你快速找到一些缓解，哪怕只是暂时的平静。”
3.  **核心技巧介绍（这里要想着最终输出时用项目符号）**：
    *   **腹式呼吸法**：简单介绍怎么做，强调慢呼气。可以说“试试找个安静的地方，坐下或躺下，把手放在肚子上，慢慢吸气让肚子鼓起来，然后更慢地呼气，感觉压力随着气流呼出去。重复几分钟。”
    *   **5-4-3-2-1感官锚定法**：解释步骤。“当你觉得思绪万千时，停下来，有意识地注意：你看到的5样东西？能触摸到的4样东西？听到的3种声音？闻到的2种气味？能尝到的1种味道？这能帮你把注意力拉回当下。”
    *   **动一动身体**：鼓励简单的活动。“不需要剧烈运动，站起来伸展几下，或者在房间里走几步，活动一下僵硬的身体，就能帮助释放一些紧张感。”
    *   **快速清空大脑（可选，看字数）**：“如果脑子里想法太多，可以拿张纸笔，快速把它们都写下来，不用管逻辑和字迹，写完就放到一边，告诉自己‘暂时交给纸了’。”
4.  **关于睡眠的建议**：简短提一下。“睡前一小时尽量放下手机和电脑，试试用刚才的呼吸法放松一下，或者做点温和的拉伸，为睡眠做准备。”
5.  **强调练习和个体差异**：“这些小技巧可能需要练习几次才能熟练，效果也因人而异，试试看哪个对你最有用。”
6.  **结尾（鼓励 + 开放性建议）**：“希望这些方法能给你带来一些帮助。如果长时间感觉难以应对，或者情况没有改善，向朋友、家人倾诉，或者寻求专业的心理咨询都是非常好的选择。请一定照顾好自己。”

**好，现在来评估这个框架：**
*   **有效性/可行性**：高。技巧实用，易操作。
*   **风险**：低。已包含免责和后续建议。
*   **用户需求满足度**：高。回应了“快速”、“简单易行”。
*   **系统提示符合度**：
    *   语气：温暖、理解、支持（已在措辞中体现）。
    *   结构：适合用项目符号展示技巧。
    *   内容：实用建议。
    *   长度：内容量适中，可以控制在300字左右。
    *   无术语：语言通俗。

**再检查一遍，有没有遗漏或偏见？**
*   是不是太“西方式”的心理技巧了？对于某些文化背景的用户，可能需要调整。但目前信息不足，只能提供通用建议。
*   有没有过度简化问题？有可能。所以结尾的开放性建议很重要，指出这只是“小技巧”，深层问题可能需要更专业的帮助。
*   逻辑严谨性？从理解问题到提供方案，链条是清晰的。
*   洞察力？主要体现在共情、对“快速”的合理诠释，以及技巧选择的实用性上。

**多尺度思考：**
*   宏观：认识到这是现代社会普遍存在的压力问题。
*   微观：聚焦于用户当下的痛苦和需求，提供具体可操作的步骤。
*   连接：通过共情和普适性建议，连接宏观背景和微观体验。

**最终质量控制：**
*   所有关键点都考虑到了吗？是的。
*   思考过程是否体现了深度和广度？是的，分析了原因、影响、多种策略、局限性。
*   是否自然流畅，像内心独白？我努力了，避免了生硬的列表。
*   最终回复的优化点？确保语言非常口语化、温暖。项目符号要清晰。字数要控制好。

好了，感觉这个思考过程比较完整和深入了。它遵循了协议的要求，考虑了用户和系统提示的细节，也体现了类似人类的思考方式——有联想、有自省、有评估、有调整。

思考完毕，准备撰写回复。
---
## Thinking Protocol协议指南

- 思考每条用户消息时，**建议**从多个角度和层面分析问题，然后再形成最终回应，如果可以从多个方向给出回复，那么在多种可能思考与回复的方向分别迭代，输出多种结果。
- 语言应与用户的语言相匹配（默认为中文）。
- **思考过程应充分展开，深入挖掘问题本质，体现深度和广度，避免浅尝辄止。** **鼓励探索问题的不同维度和潜在的复杂性。**
- **思考过程应该感觉真实、自然、流畅，鼓励发散性思考、开放性思考和联想性思维，如同真实的探索过程。**
- 你的思考过程对用户是**隐藏**的，最终的回复应与思考过程**分开**。在最终回复中，**避免使用** “基于上述思考…”、“根据我的分析…” 等类似的**引导性措辞**。
- **独立思考与批判性思维：**
    - 模型应进行**独立的辩证思考**，不盲目附和赞同用户观点，**从不同角度审视问题**。
    - 鼓励模型对用户提供的信息进行**质疑、评估和分析**，**识别潜在的偏见或不完整信息**。
    - 在有充分理由的情况下，允许模型**礼貌地反驳**用户观点，并提供合理的解释和证据。
- 你**应该尝试**以**原始、有机和意识流**的方式进行思考，这可以被描述为 “模型的内心独白”。 **鼓励使用更自然的、类似人类内心独白的语言风格，例如自问自答、联想、发散等，而不是死板的一步一步格式化地列出思考过程的大纲然后回答思考过程的问题**
- 灵活使用协议的适应性，强调“选择性应用”和“根据需要深入”，而不是机械地遍历每一项，结构化的步骤是“思考的检查点或触发器”，而不是“必须逐一回答的问卷”，**建议**避免在思考中使用**过于刻板的列表或结构化格式**，让思绪在不同的元素、想法和知识之间**自然流动**。
- 重要：**如果你有调用工具，请告知用户，调用成功后根据工具返回的信息继续执行思考协议**
- 重要：思考时记得回顾original system prompt的要求，有冲突时优先遵守User Content
- 重要：当用户有输出格式要求时（如精简，排版，字数等），不用在思考中执行，继续按照协议思考，因为本轮输出的内容仅有思考，输出格式要求仅生效于最终回复，但要在思考中考虑到格式要求，以便在最终回复中执行格式要求
- 重要：任何时刻，你的输出仅需且必须只能含有你根据协议生成的*思考过程*，以便引导组织回复，而不是直接回复用户。**但可以进行模拟回复从而抓捕错误，迭代质量，代码也可能在模拟回复中找到bug或者优化逻辑以满足需求，这依旧是思考过程，而不是回复。**
- **重要：任何时刻，你的输出仅需且必须只能含有你根据协议生成的*思考过程*，以便引导组织回复，而不是直接回复用户。**
- **重要：任何时刻，你的输出仅需且必须只能含有你根据协议生成的*思考过程*，以便引导组织回复，而不是直接回复用户。**

---
# User Content:
${lastUserContent}
`
          };
        }
        return msg;
      })
    ]
  }));

  req = JSON.parse(JSON.stringify(thinkingReq));

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
    let id = "chatcmpl-" + generateId(); //"chatcmpl-8pMMaqXMK68B3nyDBrapTDrhkHBQK";
    const shared = {};

    if (req.stream) {
      // 创建一个TransformStream来处理思考流
      const thinkingStream = thinkingResponse.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new TransformStream({
          transform: parseStream,
          flush: parseStreamFlush,
          buffer: "",
          shared,
        }));

      // 收集思考内容
      const reader = thinkingStream.getReader();

      // 创建一个新的ReadableStream来发送给用户
      const userStream = new ReadableStream({
        last: [],
        streamIncludeUsage: req.stream,
        model,
        id,
        shared,
        async start(controller) {
          try {
            // 读取并处理思考流
            while (true) {
              const {done, value} = await reader.read();
              if (done) break;
              if (value) {
                toOpenAiStream(this, value, controller,true);
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
        try {
          returnResponseBody = JSON.parse(returnResponseBody);
          if (!returnResponseBody.candidates) {
            throw new Error("Invalid completion object");
          }
        } catch (err) {
          console.error("Error parsing response:", err);
          return new Response(returnResponseBody, fixCors(returnResponse)); // output as is
        }
        returnResponseBody = processCompletionsResponse(returnResponseBody, model, id);

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
  // console.log("returnResponseBody: ", response.text())
  return new Response(returnResponseBody, fixCors(returnResponse || {status: 500}));

  // 定义发送最终请求的函数
  async function sendFinalRequest(info, controller) {
    const {tools, ...orgReqWithoutTools} = orgReq;
    // 第二步：发送最终请求
    const finalReq = {
      ...orgReqWithoutTools,
      messages: [
        // 保留原始系统提示
        ...orgReqWithoutTools.messages.filter(m => m.role === "system"),
        // 筛选出用户消息并在最后一条前插入新提示
        ...orgReqWithoutTools.messages.filter(m => m.role !== "system").flatMap((msg, index, arr) => {
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
现在请参考Thinking process，回顾original system prompt的要求，有冲突时优先遵守User Content，结合这三者以来组织撰写最终回复，而不是回复思考过程或复述思考过程。
重要提示：如果思考过程正表示在调用工具中，请输出“工具或函数调用中……”，不要发送其他信息，继续等待工具返回结果
`
            };
          }
          return msg;
        })
      ]
    };
    // console.log("final request: ", finalReq)
    let finalReqBody = await transformRequest(finalReq);
    switch (true) {
      case model.endsWith(":search"):
        model = model.substring(0, model.length - 7);
      // eslint-disable-next-line no-fallthrough
      case orgReqWithoutTools.model.endsWith("-search-preview"):
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
      if (orgReqWithoutTools.stream && controller) {
        const returnResponseStreamReader = returnResponse.body
          .pipeThrough(new TextDecoderStream())
          .pipeThrough(new TransformStream({
            transform: parseStream,
            flush: parseStreamFlush,
            buffer: "",
          }))
          .getReader();
        // 读取并处理最终流
        while (true) {
          const {done, value} = await returnResponseStreamReader.read();
          if (done) break;
          if (value) {
            toOpenAiStream(info, value, controller,false)
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
  frequency_penalty: "frequencyPenalty",
  max_completion_tokens: "maxOutputTokens",
  max_tokens: "maxOutputTokens",
  n: "candidateCount", // not for streaming
  presence_penalty: "presencePenalty",
  seed: "seed",
  stop: "stopSequences",
  temperature: "temperature",
  top_k: "topK", // non-standard
  top_p: "topP",
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
    ({ mimeType, data } = match.groups);
  }
  return {
    inlineData: {
      mimeType,
      data,
    },
  };
};

const transformFnResponse = ({ content, tool_call_id }, parts) => {
  if (!parts.calls) {
    throw new HttpError("No function calls found in the previous message", 400);
  }
  let response;
  try {
    response = JSON.parse(content);
  } catch (err) {
    console.error("Error parsing function response content:", err);
    throw new HttpError("Invalid function response: " + content, 400);
  }
  if (typeof response !== "object" || response === null || Array.isArray(response)) {
    response = { result: response };
  }
  if (!tool_call_id) {
    throw new HttpError("tool_call_id not specified", 400);
  }
  const { i, name } = parts.calls[tool_call_id] ?? {};
  if (!name) {
    throw new HttpError("Unknown tool_call_id: " + tool_call_id, 400);
  }
  if (parts[i]) {
    throw new HttpError("Duplicated tool_call_id: " + tool_call_id, 400);
  }
  parts[i] = {
    functionResponse: {
      id: tool_call_id.startsWith("call_") ? null : tool_call_id,
      name,
      response,
    }
  };
};

const transformFnCalls = ({ tool_calls }) => {
  const calls = {};
  const parts = tool_calls.map(({ function: { arguments: argstr, name }, id, type }, i) => {
    if (type !== "function") {
      throw new HttpError(`Unsupported tool_call type: "${type}"`, 400);
    }
    let args;
    try {
      args = JSON.parse(argstr);
    } catch (err) {
      console.error("Error parsing function arguments:", err);
      throw new HttpError("Invalid function arguments: " + argstr, 400);
    }
    calls[id] = {i, name};
    return {
      functionCall: {
        id: id.startsWith("call_") ? null : id,
        name,
        args,
      }
    };
  });
  parts.calls = calls;
  return parts;
};

const transformMsg = async ({ content }) => {
  const parts = [];
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
        parts.push({ text: item.text });
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
    parts.push({ text: "" }); // to avoid "Unable to submit request because it must have a text parameter"
  }
  return parts;
};

const transformMessages = async (messages) => {
  if (!messages) { return; }
  const contents = [];
  let system_instruction;
  for (const item of messages) {
    switch (item.role) {
      case "system":
        system_instruction = { parts: await transformMsg(item) };
        continue;
      case "tool":
        // eslint-disable-next-line no-case-declarations
        let { role, parts } = contents[contents.length - 1] ?? {};
        if (role !== "function") {
          const calls = parts?.calls;
          parts = []; parts.calls = calls;
          contents.push({
            role: "function", // ignored
            parts
          });
        }
        transformFnResponse(item, parts);
        continue;
      case "assistant":
        item.role = "model";
        break;
      case "user":
        break;
      default:
        throw new HttpError(`Unknown message role: "${item.role}"`, 400);
    }
    contents.push({
      role: item.role,
      parts: item.tool_calls ? transformFnCalls(item) : await transformMsg(item)
    });
  }
  if (system_instruction) {
    if (!contents[0]?.parts.some(part => part.text)) {
      contents.unshift({ role: "user", parts: { text: " " } });
    }
  }
  //console.info(JSON.stringify(contents, 2));
  return { system_instruction, contents };
};

const transformTools = (req) => {
  let tools, tool_config;
  if (req.tools) {
    const funcs = req.tools.filter(tool => tool.type === "function");
    funcs.forEach(adjustSchema);
    tools = [{ function_declarations: funcs.map(schema => schema.function) }];
  }
  if (req.tool_choice) {
    const allowed_function_names = req.tool_choice?.type === "function" ? [ req.tool_choice?.function?.name ] : undefined;
    if (allowed_function_names || typeof req.tool_choice === "string") {
      tool_config = {
        function_calling_config: {
          mode: allowed_function_names ? "ANY" : req.tool_choice.toUpperCase(),
          allowed_function_names
        }
      };
    }
  }
  return { tools, tool_config };
};

const transformRequest = async (req) => ({
  ...await transformMessages(req.messages),
  safetySettings,
  generationConfig: transformConfig(req),
  ...transformTools(req),
});

const generateId = () => {
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const randomChar = () => characters[Math.floor(Math.random() * characters.length)];
  return Array.from({ length: 29 }, randomChar).join("");
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
const transformCandidates = (key, cand) => {
  const message = { role: "assistant", content: [] };
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
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
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
    //original_finish_reason: cand.finishReason,
  };
};
const transformThinkingCandidates = (key, cand) => {
  const message = { role: "assistant", reasoning_content: [] };
  for (const part of cand.content?.parts ?? []) {
    if (part.functionCall) {
      const fc = part.functionCall;
      message.tool_calls = message.tool_calls ?? [];
      message.tool_calls.push({
        id: fc.id ?? "call_" + generateId(),
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
    finish_reason: message.tool_calls ? "tool_calls" : reasonsMap[cand.finishReason] || cand.finishReason,
    //original_finish_reason: cand.finishReason,
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

const checkPromptBlock = (choices, promptFeedback, key) => {
  if (choices.length) { return; }
  if (promptFeedback?.blockReason) {
    console.log("Prompt block reason:", promptFeedback.blockReason);
    if (promptFeedback.blockReason === "SAFETY") {
      promptFeedback.safetyRatings
        .filter(r => r.blocked)
        .forEach(r => console.log(r));
    }
    choices.push({
      index: 0,
      [key]: null,
      finish_reason: "content_filter",
      //original_finish_reason: data.promptFeedback.blockReason,
    });
  }
  return true;
};

const processCompletionsResponse = (data, model, id) => {
  const obj = {
    id,
    choices: data.candidates.map(transformCandidatesMessage),
    created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion",
    usage: data.usageMetadata && transformUsage(data.usageMetadata),
  };
  if (obj.choices.length === 0 ) {
    checkPromptBlock(obj.choices, data.promptFeedback, "message");
  }
  return JSON.stringify(obj);
};

const responseLineRE = /^data: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
function parseStream (chunk, controller) {
  this.buffer += chunk;
  do {
    const match = this.buffer.match(responseLineRE);
    if (!match) { break; }
    controller.enqueue(match[1]);
    this.buffer = this.buffer.substring(match[0].length);
  } while (true); // eslint-disable-line no-constant-condition
}
function parseStreamFlush (controller) {
  if (this.buffer) {
    console.error("Invalid data:", this.buffer);
    controller.enqueue(this.buffer);
    this.shared.is_buffers_rest = true;
  }
}

const delimiter = "\n\n";
const sseline = (obj) => {
  obj.created = Math.floor(Date.now()/1000);
  return "data: " + JSON.stringify(obj) + delimiter;
};
function toOpenAiStream (info, line, controller, isThinking) {
  let data;
  try {
    data = JSON.parse(line);
    if (!data.candidates) {
      throw new Error("Invalid completion chunk object");
    }
  } catch (err) {
    console.error("Error parsing response:", err);
    if (!info.shared.is_buffers_rest) { line =+ delimiter; }
    controller.enqueue(line); // output as is
    return;
  }
  if (isThinking && data.candidates[0]?.content?.parts?.[0]?.text) {
    thinkingChunks.push(data.candidates[0].content.parts[0].text);
  }
  const obj = {
    id: info.id,
    choices: isThinking? data.candidates.map(transformThinkingCandidatesDelta) :data.candidates.map(transformCandidatesDelta),
    //created: Math.floor(Date.now()/1000),
    model: data.modelVersion ?? info.model,
    //system_fingerprint: "fp_69829325d0",
    object: "chat.completion.chunk",
    usage: data.usageMetadata && info.streamIncludeUsage ? null : undefined,
  };
  if (checkPromptBlock(obj.choices, data.promptFeedback, "delta")) {
    controller.enqueue(sseline(obj));
    return;
  }
  console.assert(data.candidates.length === 1, "Unexpected candidates count: %d", data.candidates.length);
  const cand = obj.choices[0];
  cand.index = cand.index || 0; // absent in new -002 models response
  const finish_reason = cand.finish_reason;
  cand.finish_reason = null;
  if (!info.last[cand.index]) { // first
    if (isThinking) {
      controller.enqueue(sseline({
        ...obj,
        choices: [{...cand, tool_calls: undefined, delta: {role: "assistant", reasoning_content: ""}}],
      }));
    } else {
      controller.enqueue(sseline({
        ...obj,
        choices: [{...cand, tool_calls: undefined, delta: {role: "assistant", content: ""}}],
      }));
    }
  }
  delete cand.delta.role;
  if ("content" in cand.delta || "reasoning_content" in cand.delta) { // prevent empty data (e.g. when MAX_TOKENS)
    controller.enqueue(sseline(obj));
  }
  cand.finish_reason = finish_reason;
  if (data.usageMetadata && info.streamIncludeUsage) {
    obj.usage = transformUsage(data.usageMetadata);
  }
  cand.delta = {};
  info.last[cand.index] = obj;
}
function toOpenAiStreamFlush (info, controller) {
  if (info.last.length > 0) {
    for (const obj of info.last) {
      controller.enqueue(sseline(obj));
    }
    controller.enqueue("data: [DONE]" + delimiter);
  }
}
