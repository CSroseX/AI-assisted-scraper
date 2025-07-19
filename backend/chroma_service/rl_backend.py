import os
from flask import Flask, request, jsonify
from flask_cors import CORS
from stable_baselines3 import PPO
from stable_baselines3.common.vec_env import DummyVecEnv
import gym
import numpy as np

app = Flask(__name__)
CORS(app)

# Dummy text environment for RL (replace with real text env for production)
class TextReviewEnv(gym.Env):
    def __init__(self):
        super(TextReviewEnv, self).__init__()
        self.action_space = gym.spaces.Discrete(2)  # 0: bad, 1: good (dummy)
        self.observation_space = gym.spaces.Box(low=0, high=1, shape=(1,), dtype=np.float32)
        self.state = np.array([0.0])
        self.last_action = 0
    def reset(self):
        self.state = np.array([0.0])
        return self.state
    def step(self, action):
        self.last_action = action
        reward = 0.0  # reward will be set externally
        done = True
        info = {}
        return self.state, reward, done, info

# Create and wrap the environment
env = DummyVecEnv([lambda: TextReviewEnv()])
model = PPO('MlpPolicy', env, verbose=0)

# Store last obs/action for feedback
last_obs = None
last_action = None

@app.route('/review', methods=['POST'])
def review():
    global last_obs, last_action
    data = request.json
    # For demo, ignore input and generate dummy review
    obs = env.reset()
    action, _ = model.predict(obs)
    last_obs = obs
    last_action = action
    # Dummy review text
    review_text = "This is a dummy RL-based review. Action: {}".format(int(action[0]))
    return jsonify({'reviewed': review_text, 'action': int(action[0])})

@app.route('/feedback', methods=['POST'])
def feedback():
    global last_obs, last_action
    data = request.json
    reward = float(data.get('reward', 0))
    # One training step with the reward
    if last_obs is not None and last_action is not None:
        # Manually set reward for the last action
        env.envs[0].last_action = last_action[0]
        # Stable Baselines3 does not support manual reward injection directly,
        # so this is a placeholder for a real RL text environment.
        # In production, use a custom env that takes reward from feedback.
        # Here, we just call learn() for demonstration.
        model.learn(total_timesteps=1)
    return jsonify({'status': 'feedback received', 'reward': reward})

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5050) 