const WebSocket = require('ws');
const https = require('https');

const REST_API_URL = 'https://zkyicpu7dd.execute-api.eu-central-1.amazonaws.com/prod';
const WEBSOCKET_URL = 'wss://ca9ubumuug.execute-api.eu-central-1.amazonaws.com/dev';

async function makeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'zkyicpu7dd.execute-api.eu-central-1.amazonaws.com',
      path: `/prod${path}`,
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ statusCode: res.statusCode, body: parsed });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function test() {
  console.log('=== Testing WebSocket Connect & Participant List ===\n');

  // 1. Create a room
  console.log('1. Creating room...');
  const createResult = await makeRequest('POST', '/rooms', {
    allowAllParticipantsToReveal: true,
    deck: 'fibonacci',
  });

  if (createResult.statusCode !== 201) {
    console.error(`Failed to create room: ${createResult.statusCode}`, createResult.body);
    return;
  }

  const roomId = createResult.body.roomId;
  const shortCode = createResult.body.shortCode;
  console.log(`   Room created: ${shortCode} (ID: ${roomId})`);

  // 2. Join the room
  console.log(`\n2. Joining room ${shortCode}...`);
  const joinResult = await makeRequest('GET', `/rooms/${shortCode}?name=TestUser`);

  if (joinResult.statusCode !== 200) {
    console.error(`Failed to join room: ${joinResult.statusCode}`, joinResult.body);
    return;
  }

  const participantId = joinResult.body.participantId;
  console.log(`   Joined as participant: ${participantId}`);

  // 3. Connect to WebSocket
  console.log('\n3. Connecting to WebSocket...');
  const wsUrl = `${WEBSOCKET_URL}?roomId=${roomId}&participantId=${participantId}`;
  const ws = new WebSocket(wsUrl);

  const messages = [];
  let receivedParticipantList = false;

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      messages.push(message);
      console.log(
        `   [WS Received] ${message.type}:`,
        JSON.stringify(message.payload).substring(0, 100)
      );

      if (message.type === 'participantList') {
        receivedParticipantList = true;
        console.log(
          `   ✓ Got participantList with ${message.payload.participants?.length || 0} participants`
        );
      }
      if (message.type === 'roundUpdate') {
        console.log(`   ✓ Got roundUpdate with round ID: ${message.payload.round?.id}`);
      }
      if (message.type === 'error') {
        console.log(`   ✗ Error: ${message.payload.message}`);
      }
    } catch (e) {
      console.log(`   [WS Raw] ${data.toString().substring(0, 100)}`);
    }
  });

  await new Promise((resolve, reject) => {
    ws.on('open', () => {
      console.log('   WebSocket connected');
      resolve();
    });

    ws.on('error', (err) => {
      console.error('   WebSocket connection error:', err.message);
      reject(err);
    });

    setTimeout(() => {
      reject(new Error('WebSocket connection timeout'));
    }, 10000);
  });

  // Wait for participantList (should come soon after connect)
  console.log('\n4. Waiting for participantList message...');
  for (let i = 0; i < 10; i++) {
    if (receivedParticipantList) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    process.stdout.write('.');
  }
  console.log();

  if (receivedParticipantList) {
    console.log('\n✅ SUCCESS: Received participantList broadcast');
  } else {
    console.log('\n❌ FAIL: Did not receive participantList broadcast');
    console.log('   Messages received:', messages.length);
    messages.forEach((msg, i) => {
      console.log(`   [${i}] ${JSON.stringify(msg)}`);
    });
  }

  console.log('\n5. Closing connection...');
  ws.close();

  console.log('\n=== Test complete ===');
}

test().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
