import { defineChannel } from "@theopenbee/channel-sdk";

import { createWeixinChannel } from "./weixin.js";

defineChannel(createWeixinChannel());
