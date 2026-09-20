'use strict';

var path = require('path');
var express = require('express');
var Anonymizer = require('./public/anonymizer');
var sample = require('./sample');

var app = express();
var PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 内置示例
app.get('/api/sample', function (req, res) {
  res.json({ text: sample.TEXT, rules: sample.RULES });
});

// 匿名化计算（与浏览器端同一份引擎，便于校验/二次开发）
app.post('/api/anonymize', function (req, res) {
  var text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
  var rules = req.body && Array.isArray(req.body.rules) ? req.body.rules : [];
  var result = Anonymizer.anonymize(text, rules);
  res.json({
    preview: result.preview,
    hits: result.hits,
    segments: result.segments,
  });
});

app.listen(PORT, function () {
  console.log('访谈稿匿名化映射编辑器已启动: http://localhost:' + PORT);
});
